import { validarConfig } from './config.js';
import { procesarCorreo } from './llm/agente.js';
import {
  obtenerAnalitica,
  registrarMensaje,
  registrarEvento,
  cerrarConversacionesInactivas,
} from './services/conversaciones.js';
import { contarEstudiantesActivos } from './services/busqueda.js';
import { resolverEscalamiento, extraerCodigoCaso } from './services/escalamientos.js';

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
 * Lambda expuesta vía Function URL.
 *
 * POST /                             correo entrante parseado por n8n (flujo principal)
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
    validarConfig();

    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

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

    // Flujo 2 de n8n: un agente digital respondió un caso escalado.
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

      const resultado = await resolverEscalamiento({
        codigo,
        respuestaAgente: body.respuesta,
        correoAgente: body.correoAgente,
      });

      if (resultado.status === 'OK') {
        await registrarMensaje(resultado.hiloId, { rol: 'asistente', cuerpo: resultado.textoRespuesta });
        await registrarEvento(resultado.hiloId, {
          tipo: 'respuesta_agente_entregada',
          detalle: { codigo, correoAgente: body.correoAgente || null },
        });
      }

      return respuestaJson(resultado.status === 'OK' ? 200 : 404, resultado);
    }

    // Flujo principal: correo entrante del usuario final.
    const body = parsearBody(event);
    if (!body) {
      return respuestaJson(400, { error: 'Falta el body de la solicitud' });
    }

    const faltantes = ['hiloId', 'remitente', 'cuerpo'].filter((c) => !body[c]);
    if (faltantes.length > 0) {
      return respuestaJson(400, { error: `Faltan campos: ${faltantes.join(', ')}` });
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
