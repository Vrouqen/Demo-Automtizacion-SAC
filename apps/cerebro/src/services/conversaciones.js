import { coleccionConversaciones } from '../db/mongo.js';

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
    'y con gusto lo retomamos.\n\n' +
    'Soporte Santillana Ecuador';

  const casos = [];
  for (const conv of pendientes) {
    const ultimoUsuario = [...(conv.mensajes || [])]
      .reverse()
      .find((m) => m.rol === 'usuario' && m.mensajeId);

    await col.updateOne(
      { _id: conv._id },
      {
        $set: { estado: 'cerrado_inactividad', actualizadoEn: new Date() },
        $push: {
          mensajes: { rol: 'asistente', cuerpo: texto, fecha: new Date() },
          eventos: { tipo: 'cerrado_por_inactividad', detalle: { horas }, fecha: new Date() },
        },
      }
    );

    casos.push({
      hiloId: conv._id,
      mensajeId: ultimoUsuario?.mensajeId || null,
      remitente: conv.remitente,
      textoRespuesta: texto,
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

/**
 * Analítica agregada para KPIs del piloto (tickets por tipo/estado,
 * eventos por tipo, total de conversaciones).
 */
export async function obtenerAnalitica({ desde, hasta } = {}) {
  const col = await coleccionConversaciones();
  const filtroFecha = {};
  if (desde) filtroFecha.$gte = new Date(desde);
  if (hasta) filtroFecha.$lte = new Date(hasta);
  const match = Object.keys(filtroFecha).length > 0 ? { creadoEn: filtroFecha } : {};

  const conversaciones = await col.find(match).toArray();

  const resumen = {
    totalConversaciones: conversaciones.length,
    totalTickets: 0,
    ticketsPorTipo: {},
    ticketsPorEstado: {},
    eventosPorTipo: {},
  };

  for (const conv of conversaciones) {
    for (const t of conv.tickets || []) {
      resumen.totalTickets++;
      resumen.ticketsPorTipo[t.tipo] = (resumen.ticketsPorTipo[t.tipo] || 0) + 1;
      resumen.ticketsPorEstado[t.estado] = (resumen.ticketsPorEstado[t.estado] || 0) + 1;
    }
    for (const e of conv.eventos || []) {
      resumen.eventosPorTipo[e.tipo] = (resumen.eventosPorTipo[e.tipo] || 0) + 1;
    }
  }

  return resumen;
}
