import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { coleccionEscalamientos } from '../db/mongo.js';
import { textoAHtml } from '../utils/correo.js';

/**
 * Escalamiento = un caso que el asistente no pudo resolver (ej. colegio no
 * encontrado tras pedir nombre alternativo) y se deriva a una PERSONA: un
 * agente digital de servicio.
 *
 * Flujo completo:
 *  1. El cerebro crea el escalamiento (este módulo) y devuelve a n8n el correo
 *     de delegación listo para enviar al agente (accion: "escalar").
 *  2. n8n envía ese correo al agente Y responde al usuario final en su mismo
 *     hilo avisando que un digital de servicio atenderá el caso.
 *  3. El agente responde al correo de delegación MANTENIENDO el código
 *     [CASO-XXXXXX] en el asunto.
 *  4. Un segundo flujo de n8n detecta esa respuesta, llama al cerebro
 *     (POST ?accion=respuesta_agente) y éste devuelve el hiloId/mensajeId del
 *     correo ORIGINAL del cliente para responderle en su mismo hilo.
 */

export function extraerCodigoCaso(texto) {
  const m = String(texto || '').match(/CASO-[A-Z0-9]{6,10}/i);
  return m ? m[0].toUpperCase() : null;
}

export async function crearEscalamiento({ hiloId, mensajeId, remitente, asunto, motivo, resumen }) {
  const agentes = config.agentes.correos;
  if (agentes.length === 0) {
    throw new Error('No hay agentes digitales configurados (AGENTES_DIGITALES)');
  }

  const col = await coleccionEscalamientos();

  // Round-robin simple: reparte según cuántos casos se han creado.
  const creados = await col.countDocuments();
  const agenteEmail = agentes[creados % agentes.length];

  const codigo = `CASO-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

  const escalamiento = {
    _id: codigo,
    hiloId,
    mensajeId,
    remitente,
    asuntoOriginal: asunto || '',
    motivo, // ej. 'colegio_no_encontrado'
    resumen,
    agenteEmail,
    estado: 'pendiente_agente',
    creadoEn: new Date(),
    respuestaAgente: null,
    respondidoEn: null,
  };
  await col.insertOne(escalamiento);

  const cuerpoDelegacion =
    `Hola,\n\n` +
    `El asistente automático de soporte no pudo resolver el siguiente caso y te lo delega:\n\n` +
    `- Código del caso: ${codigo}\n` +
    `- Usuario final: ${remitente}\n` +
    `- Asunto original: ${asunto || '(sin asunto)'}\n` +
    `- Motivo del escalamiento: ${motivo}\n\n` +
    `Resumen del caso:\n\n${resumen}\n\n` +
    `IMPORTANTE: responde a ESTE correo con la solución, manteniendo el código ${codigo} en el asunto. ` +
    `Tu respuesta se reenviará automáticamente al usuario final en su hilo de correo original — ` +
    `escríbela como si le hablaras directamente a él/ella.\n\n` +
    `Soporte Santillana Ecuador (asistente automático)`;

  return {
    codigo,
    agenteEmail,
    // Correo de delegación listo para que n8n lo envíe tal cual.
    // cuerpoHtml es el que debe usar el nodo de Outlook (Graph renderiza el
    // cuerpo como HTML; con el texto plano los saltos de línea colapsan).
    correoDelegacion: {
      para: agenteEmail,
      asunto: `[${codigo}] Caso delegado por el asistente de soporte — ${asunto || 'sin asunto'}`,
      cuerpo: cuerpoDelegacion,
      cuerpoHtml: textoAHtml(cuerpoDelegacion),
    },
  };
}

/**
 * Registra la respuesta del agente digital y devuelve los datos del hilo
 * ORIGINAL del cliente para que n8n responda allí.
 */
export async function resolverEscalamiento({ codigo, respuestaAgente, correoAgente }) {
  const col = await coleccionEscalamientos();
  const escalamiento = await col.findOne({ _id: codigo });

  if (!escalamiento) {
    return { status: 'CASO_NO_ENCONTRADO', codigo };
  }
  if (escalamiento.estado === 'resuelto') {
    return { status: 'YA_RESUELTO', codigo, hiloId: escalamiento.hiloId };
  }

  await col.updateOne(
    { _id: codigo },
    {
      $set: {
        estado: 'resuelto',
        respuestaAgente,
        respondidoPor: correoAgente || escalamiento.agenteEmail,
        respondidoEn: new Date(),
      },
    }
  );

  const textoRespuesta =
    `Estimado/a usuario/a:\n\n` +
    `Su caso (${codigo}) fue atendido por nuestro equipo de servicio digital. Esta es la respuesta:\n\n` +
    `${respuestaAgente}\n\n` +
    `Si necesita algo más, puede responder a este mismo correo.\n\n` +
    `Soporte Santillana Ecuador`;

  return {
    status: 'OK',
    codigo,
    hiloId: escalamiento.hiloId,
    mensajeId: escalamiento.mensajeId,
    remitente: escalamiento.remitente,
    textoRespuesta,
    textoRespuestaHtml: textoAHtml(textoRespuesta),
  };
}
