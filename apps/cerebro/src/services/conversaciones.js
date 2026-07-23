import { coleccionConversaciones, coleccionDescartes } from '../db/mongo.js';
import { textoAHtml } from '../utils/correo.js';
import { esCorreoInterno } from '../config.js';
import { conFirmaTexto } from '../utils/firma.js';

/**
 * Deja constancia de un correo descartado por el filtro de basura. No crea
 * conversación (no se atiende), pero sí alimenta la analítica: sin este
 * registro el filtro sería una caja negra imposible de afinar. Nunca debe
 * tumbar el flujo: si el registro falla, el correo igual se descarta.
 */
export async function registrarDescarte({ hiloId, mensajeId, remitente, asunto, categoria, senal }) {
  try {
    const col = await coleccionDescartes();
    await col.insertOne({ hiloId, mensajeId, remitente, asunto, categoria, senal, fecha: new Date() });
  } catch (err) {
    console.error('[descarte] no se pudo registrar:', err.message);
  }
}

/**
 * Una "conversación" = un hilo de correo. Guarda mensajes (para threading y
 * para reconstruir el historial en cada invocación, ya que Lambda es stateless),
 * tickets creados (para enlazar el siguiente al anterior) y eventos (para la
 * analítica del piloto).
 */
export async function obtenerOCrearConversacion({ hiloId, remitente, cuentaSoporte, asunto }) {
  const col = await coleccionConversaciones();
  await col.updateOne(
    { _id: hiloId },
    {
      $setOnInsert: {
        _id: hiloId,
        remitente,
        cuentaSoporte,
        asunto,
        estado: 'abierto',
        creadoEn: new Date(),
        actualizadoEn: new Date(),
        mensajes: [],
        tickets: [],
        eventos: [],
      },
    },
    { upsert: true }
  );
  // No devolvemos el documento: el único llamador (procesarCorreo) vuelve a
  // leer la conversación DESPUÉS de registrar el mensaje del usuario, así que
  // un findOne aquí sería una lectura desperdiciada en el camino caliente.
}

export async function registrarMensaje(hiloId, mensaje) {
  const col = await coleccionConversaciones();
  await col.updateOne(
    { _id: hiloId },
    { $push: { mensajes: { ...mensaje, fecha: new Date() } }, $set: { actualizadoEn: new Date() } }
  );
}

export async function registrarEvento(hiloId, evento) {
  const col = await coleccionConversaciones();
  await col.updateOne(
    { _id: hiloId },
    { $push: { eventos: { ...evento, fecha: new Date() } }, $set: { actualizadoEn: new Date() } }
  );
}

/**
 * Estados de una conversación:
 *  abierto | esperando_usuario | esperando_agente | resuelto | cerrado |
 *  cerrado_inactividad.
 * Solo 'esperando_usuario' es candidato al cierre automático por 24h.
 */
export async function actualizarEstado(hiloId, estado) {
  const col = await coleccionConversaciones();
  await col.updateOne({ _id: hiloId }, { $set: { estado, actualizadoEn: new Date() } });
}

/**
 * Cierra las conversaciones que quedaron 'esperando_usuario' sin respuesta por
 * más de `horas`. Devuelve los datos que n8n necesita para enviar el correo de
 * cierre (mensajeId del ÚLTIMO correo del usuario, para responder en su hilo).
 */
export async function cerrarConversacionesInactivas({ horas = 24 } = {}) {
  const col = await coleccionConversaciones();
  const limite = new Date(Date.now() - horas * 3600 * 1000);
  const pendientes = await col
    .find({ estado: 'esperando_usuario', actualizadoEn: { $lt: limite } })
    .toArray();

  const texto =
    'Estimado/a usuario/a:\n\n' +
    'No recibimos la información que necesitábamos para continuar con su solicitud, por lo que ' +
    'cerramos este caso por el momento. Si aún necesita ayuda, puede responder a este mismo correo ' +
    'y con gusto lo retomamos.';

  const casos = [];
  for (const conv of pendientes) {
    // GUARDA: nunca enviar el correo de cierre a una dirección INTERNA (agente
    // digital, buzón de equipo o soporte). Esas conversaciones son basura: el
    // hilo de un AVISO que por error quedó registrado como si el agente fuera un
    // "usuario". Se cierran EN SILENCIO (sin correo) para limpiar el estado y que
    // no reaparezcan, pero NO se le escribe a nadie.
    const interno = esCorreoInterno(conv.remitente);

    const ultimoUsuario = [...(conv.mensajes || [])]
      .reverse()
      .find((m) => m.rol === 'usuario' && m.mensajeId);

    await col.updateOne(
      { _id: conv._id },
      {
        $set: { estado: 'cerrado_inactividad', actualizadoEn: new Date() },
        $push: {
          eventos: {
            tipo: interno ? 'cerrado_inactividad_interno_sin_aviso' : 'cerrado_por_inactividad',
            detalle: { horas },
            fecha: new Date(),
          },
          ...(interno ? {} : { mensajes: { rol: 'asistente', cuerpo: texto, fecha: new Date() } }),
        },
      }
    );

    if (interno) continue; // cerrada en silencio: no se avisa a una dirección interna

    casos.push({
      hiloId: conv._id,
      mensajeId: ultimoUsuario?.mensajeId || null,
      remitente: conv.remitente,
      textoRespuesta: conFirmaTexto(texto),
      textoRespuestaHtml: textoAHtml(texto),
    });
  }
  return casos;
}

export async function registrarTicket(hiloId, ticket) {
  const col = await coleccionConversaciones();
  await col.updateOne({ _id: hiloId }, { $push: { tickets: { ...ticket, creadoEn: new Date() } } });
}

export async function obtenerUltimoTicket(hiloId) {
  const col = await coleccionConversaciones();
  const conv = await col.findOne({ _id: hiloId }, { projection: { tickets: 1 } });
  const tickets = conv?.tickets || [];
  return tickets.length > 0 ? tickets[tickets.length - 1] : null;
}
