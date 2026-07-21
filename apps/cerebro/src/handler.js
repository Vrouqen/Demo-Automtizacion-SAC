import { config, validarConfig } from './config.js';
import { procesarCorreo } from './llm/agente.js';
import { obtenerAnalitica } from './services/analitica.js';
import { paginaDashboard } from './dashboard.js';
import { bytesLogo } from './utils/firma.js';
import {
  registrarMensaje,
  registrarEvento,
  cerrarConversacionesInactivas,
} from './services/conversaciones.js';
import { contarEstudiantesActivos } from './services/busqueda.js';
import {
  resolverEscalamiento,
  extraerCodigoCaso,
  buscarEscalamientoPendiente,
  registrarHiloDelegacion,
} from './services/escalamientos.js';
import { limpiarCuerpoCorreo } from './utils/correo.js';

function respuestaJson(statusCode, cuerpo) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  };
}

function parsearBody(event) {
  if (!event.body) return null;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(raw);
}

/**
 * Marca el caso como resuelto y deja registrada la respuesta en el hilo del
 * cliente. El cuerpo del agente llega como HTML de Outlook con el correo de
 * delegación citado debajo: se limpia para que al cliente solo le llegue lo
 * que el agente escribió.
 */
async function entregarRespuestaAgente({ codigo, cuerpo, correoAgente }) {
  const resultado = await resolverEscalamiento({
    codigo,
    respuestaAgente: limpiarCuerpoCorreo(cuerpo),
    correoAgente,
  });

  if (resultado.status === 'OK') {
    await registrarMensaje(resultado.hiloId, { rol: 'asistente', cuerpo: resultado.textoRespuesta });
    await registrarEvento(resultado.hiloId, {
      tipo: 'respuesta_agente_entregada',
      detalle: { codigo, correoAgente: correoAgente || null },
    });
  }
  return resultado;
}

/**
 * Lambda expuesta vía Function URL.
 *
 * POST /                             correo entrante parseado por n8n (flujo principal).
 *                                    Devuelve "accion", que es la rama que toma n8n:
 *                                      escalar | responder | responder_y_crear_ticket
 *                                      ignorar  -> correo basura: moverlo a Correo no deseado
 *                                      ninguna  -> no hacer nada (duplicado, auto-respuesta)
 *                                      error_temporal (503) -> reintentar después
 * POST /?accion=respuesta_agente     respuesta de un agente digital a un caso escalado
 *                                    body: { codigo?, asunto?, respuesta, correoAgente? }
 *                                    (si no viene "codigo", se extrae CASO-XXXXXX del asunto)
 * GET  /?reporte=analitica           analítica agregada del piloto
 * GET  /?reporte=estudiantes_activos&idColegio=<id Pegasus>
 *                                    cantidad de estudiantes activos (activo = tiene credenciales)
 * GET  /?accion=cerrar_inactivas&horas=24
 *                                    cierra conversaciones esperando al usuario sin respuesta;
 *                                    devuelve los casos a los que n8n debe enviar el correo de cierre
 */
export const handler = async (event) => {
  try {
    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

    // Logo de la firma (opción B). Es un asset ESTÁTICO y PÚBLICO: los clientes
    // de correo lo piden sin autenticación. Va antes de validarConfig porque no
    // necesita Mongo ni Gemini, y se cachea un año (los logos no cambian; si uno
    // cambia, se sirve con otro nombre). El binario se devuelve en base64.
    if (metodo === 'GET' && query.logo) {
      const bytes = bytesLogo(query.logo);
      if (!bytes) return respuestaJson(404, { error: 'Logo no encontrado' });
      return {
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
        body: bytes.toString('base64'),
        isBase64Encoded: true,
      };
    }

    validarConfig();

    // La analítica y el dashboard son de consulta interna. Si hay token
    // configurado, se exige en ambos (la página lo propaga al pedir los datos
    // porque va en su propia URL).
    const esConsultaInterna = query.vista === 'dashboard' || query.reporte === 'analitica';
    if (esConsultaInterna && config.dashboard.token && query.token !== config.dashboard.token) {
      return respuestaJson(401, { error: 'No autorizado' });
    }

    // Dashboard en vivo. Se sirve desde la misma URL que los datos, así que la
    // página consulta ?reporte=analitica sin problemas de CORS.
    if (metodo === 'GET' && query.vista === 'dashboard') {
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        body: paginaDashboard(),
      };
    }

    if (metodo === 'GET' && query.reporte === 'analitica') {
      const resumen = await obtenerAnalitica({ desde: query.desde, hasta: query.hasta });
      return respuestaJson(200, resumen);
    }

    if (metodo === 'GET' && query.reporte === 'estudiantes_activos') {
      if (!query.idColegio) {
        return respuestaJson(400, { error: 'Falta el parámetro idColegio (id del colegio en Pegasus)' });
      }
      const resultado = await contarEstudiantesActivos({ idColegio: query.idColegio });
      return respuestaJson(resultado.status === 'OK' ? 200 : 404, resultado);
    }

    // Cierre automático por inactividad (lo invoca un workflow programado de n8n).
    if (metodo === 'GET' && query.accion === 'cerrar_inactivas') {
      const horas = query.horas ? Number(query.horas) : 24;
      const casos = await cerrarConversacionesInactivas({ horas });
      return respuestaJson(200, { cerradas: casos.length, casos });
    }

    // n8n avisa el hilo del correo de delegación recién enviado al agente.
    // Con eso, su respuesta se reconoce por conversationId (robusto) en vez de
    // por el texto del asunto.
    if (metodo === 'POST' && query.accion === 'registrar_delegacion') {
      const body = parsearBody(event);
      if (!body?.codigo) return respuestaJson(400, { error: 'Falta "codigo"' });
      const r = await registrarHiloDelegacion({
        codigo: body.codigo,
        conversationIdDelegacion: body.conversationIdDelegacion,
        mensajeIdDelegacion: body.mensajeIdDelegacion,
      });
      return respuestaJson(r.status === 'OK' ? 200 : 404, r);
    }

    // Compatibilidad: llamada explícita para resolver un caso (flujo 2 antiguo).
    if (metodo === 'POST' && query.accion === 'respuesta_agente') {
      const body = parsearBody(event);
      if (!body) return respuestaJson(400, { error: 'Falta el body de la solicitud' });

      const codigo = body.codigo || extraerCodigoCaso(body.asunto);
      if (!codigo) {
        return respuestaJson(400, { error: 'No se encontró el código de caso (CASO-XXXXXX) ni en "codigo" ni en "asunto"' });
      }
      if (!body.respuesta) {
        return respuestaJson(400, { error: 'Falta el campo "respuesta" (texto del correo del agente)' });
      }

      const resultado = await entregarRespuestaAgente({
        codigo,
        cuerpo: body.respuesta,
        correoAgente: body.correoAgente,
      });
      return respuestaJson(resultado.status === 'OK' ? 200 : 404, resultado);
    }

    // Flujo principal: TODO correo entrante del buzón de soporte entra por aquí
    // (consultas de clientes y respuestas de agentes a casos delegados).
    const body = parsearBody(event);
    if (!body) {
      return respuestaJson(400, { error: 'Falta el body de la solicitud' });
    }

    const faltantes = ['hiloId', 'remitente', 'cuerpo'].filter((c) => !body[c]);
    if (faltantes.length > 0) {
      return respuestaJson(400, { error: `Faltan campos: ${faltantes.join(', ')}` });
    }

    // ¿Es la respuesta de un agente digital a un caso delegado? Se detecta por
    // el conversationId del hilo de delegación (no por el asunto). Si lo es, la
    // respuesta va al hilo ORIGINAL del cliente, no a este.
    const escalamiento = await buscarEscalamientoPendiente({
      hiloId: body.hiloId,
      asunto: body.asunto,
      remitente: body.remitente,
    });
    if (escalamiento) {
      const resultado = await entregarRespuestaAgente({
        codigo: escalamiento._id,
        cuerpo: body.cuerpo,
        correoAgente: body.remitente,
      });
      if (resultado.status !== 'OK') {
        return respuestaJson(200, { accion: 'ninguna', motivo: resultado.status, codigo: escalamiento._id });
      }
      return respuestaJson(200, {
        accion: 'responder_al_cliente',
        codigo: resultado.codigo,
        hiloId: resultado.hiloId,
        // Mensaje del correo ORIGINAL del cliente: ahí se responde. Siempre
        // presente (null si falta) para que n8n pueda comprobarlo antes de
        // llamar a Graph, que con un id vacío devuelve "Id is malformed".
        mensajeIdRespuesta: resultado.mensajeId || null,
        textoRespuesta: resultado.textoRespuesta,
        textoRespuestaHtml: resultado.textoRespuestaHtml,
      });
    }

    const resultado = await procesarCorreo(body);
    // El servicio de IA falló (cuota agotada / rate limit / caída temporal): NO
    // se envió respuesta al usuario. Devolvemos 503 para que n8n corte la rama de
    // respuesta y el mismo correo se reprocese luego (el trigger lo vuelve a traer,
    // o se reintenta), sin marcar el hilo como respondido.
    if (resultado.accion === 'error_temporal') {
      return respuestaJson(503, resultado);
    }
    return respuestaJson(200, resultado);
  } catch (err) {
    console.error(err);
    return respuestaJson(500, { error: err.message });
  }
};
