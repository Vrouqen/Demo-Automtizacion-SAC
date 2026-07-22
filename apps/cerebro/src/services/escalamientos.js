import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { coleccionEscalamientos } from '../db/mongo.js';
import { textoAHtml } from '../utils/correo.js';
import { conFirmaTexto } from '../utils/firma.js';

/**
 * Escalamiento = un caso que el asistente no pudo resolver y se deriva a una
 * PERSONA (agente digital de servicio).
 *
 * Flujo completo (un solo workflow de n8n):
 *  1. El cerebro crea el escalamiento y devuelve a n8n el correo de delegación
 *     listo para enviar al agente (accion: "escalar").
 *  2. n8n envía ese correo al agente, le informa al cerebro el conversationId
 *     del hilo de delegación recién creado (?accion=registrar_delegacion), y
 *     responde al usuario final en su propio hilo.
 *  3. El agente responde al correo de delegación.
 *  4. Ese correo entra por el MISMO trigger que todo lo demás. El cerebro lo
 *     reconoce porque su conversationId es el del hilo de delegación guardado
 *     en el paso 2 — NO por el texto del asunto — y devuelve el mensajeId del
 *     correo ORIGINAL del cliente para responderle ahí.
 *
 * El código [CASO-XXXXXX] sigue yendo en el asunto, pero solo para que un
 * humano lo lea y como respaldo si el registro del conversationId falló.
 */

const MOTIVOS_LEGIBLES = {
  colegio_no_encontrado: 'Institución educativa no encontrada',
  estudiante_no_encontrado: 'Estudiante no encontrado',
  otro: 'Consulta fuera de las funciones automáticas',
};

export function extraerCodigoCaso(texto) {
  const m = String(texto || '').match(/CASO-[A-Z0-9]{6,10}/i);
  return m ? m[0].toUpperCase() : null;
}

// Código de una derivación en el asunto: CASO-XXX (caso) o PENDIENTE-XXX / la
// clave real de Jira (ticket). Es el respaldo de detección si el registro del
// conversationId falló. Exportada para pruebas.
export function extraerCodigoDerivacion(texto) {
  const m = String(texto || '').match(/(?:CASO|PENDIENTE|[A-Z]{2,10})-[A-Z0-9]{4,12}/i);
  return m ? m[0].toUpperCase() : null;
}

const norm = (s) => String(s || '').trim().toLowerCase();

// ¿El remitente es quien ATIENDE esta derivación (un agente digital o un buzón
// de equipo), y no el cliente que la originó? Evita cerrar la derivación con el
// propio texto citado por el cliente. Exportada para pruebas.
export function esCorreoDeManejador(remitente, registro) {
  const de = norm(remitente);
  if (!de || de === norm(registro.remitente)) return false;
  const candidatos = [
    ...String(registro.agenteEmail || '').split(',').map(norm),
    ...config.agentes.correos.map(norm),
    norm(config.equipos?.cuentas),
    norm(config.equipos?.servicioDigital),
  ].filter(Boolean);
  return candidatos.includes(de);
}

/**
 * Reparto equitativo de casos entre agentes digitales.
 *
 * El criterio es la carga REAL, no cuántos casos ha recibido históricamente:
 * solo cuentan los casos que tiene abiertos (`pendiente_agente`). Un agente que
 * resolvió sus diez casos está libre y vuelve a ser candidato; el que acumula
 * tres sin responder no recibe más hasta descargarse. (Antes era un round-robin
 * por total de casos creados, que repartía parejo aunque uno estuviera saturado.)
 *
 * Desempates, en orden: quien lleve más tiempo sin recibir un caso, y por
 * último el orden alfabético para que el resultado sea determinista.
 */
export async function elegirAgenteMenosCargado(col) {
  const agentes = config.agentes.correos;
  if (agentes.length === 1) return agentes[0];

  // Solo CASOS: los tickets van a un equipo fijo, no entran en el reparto.
  const soloCasos = { tipo: { $ne: 'ticket' } };
  const [abiertos, ultimos] = await Promise.all([
    col.aggregate([
      { $match: { ...soloCasos, estado: 'pendiente_agente' } },
      { $group: { _id: '$agenteEmail', n: { $sum: 1 } } },
    ]).toArray(),
    col.aggregate([{ $match: soloCasos }, { $group: { _id: '$agenteEmail', ultimo: { $max: '$creadoEn' } } }]).toArray(),
  ]);

  const carga = new Map(abiertos.map((d) => [d._id, d.n]));
  const ultimoCaso = new Map(ultimos.map((d) => [d._id, d.ultimo ? new Date(d.ultimo).getTime() : 0]));

  return [...agentes].sort(
    (a, b) =>
      (carga.get(a) || 0) - (carga.get(b) || 0) ||
      (ultimoCaso.get(a) || 0) - (ultimoCaso.get(b) || 0) ||
      a.localeCompare(b)
  )[0];
}

/**
 * Carga actual por agente (para la analítica y el dashboard): casos abiertos,
 * resueltos y tiempo medio de respuesta.
 */
export async function cargaPorAgente() {
  const col = await coleccionEscalamientos();
  const filas = await col
    .aggregate([
      { $match: { tipo: { $ne: 'ticket' } } }, // carga de CASOS, no de tickets
      {
        $group: {
          _id: '$agenteEmail',
          abiertos: { $sum: { $cond: [{ $eq: ['$estado', 'pendiente_agente'] }, 1, 0] } },
          resueltos: { $sum: { $cond: [{ $eq: ['$estado', 'resuelto'] }, 1, 0] } },
          total: { $sum: 1 },
          msRespuestaTotal: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$respondidoEn', null] }, { $ne: ['$creadoEn', null] }] },
                { $subtract: ['$respondidoEn', '$creadoEn'] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return filas.map((f) => ({
    agente: f._id,
    abiertos: f.abiertos,
    resueltos: f.resueltos,
    total: f.total,
    horasPromedioRespuesta: f.resueltos > 0 ? +(f.msRespuestaTotal / f.resueltos / 3600000).toFixed(2) : null,
  }));
}

function seccion(titulo, contenido) {
  const valor = String(contenido || '').trim();
  return `${titulo}\n${valor || '(no proporcionado por el usuario)'}`;
}

export async function crearEscalamiento({
  hiloId,
  mensajeId,
  remitente,
  asunto,
  motivo,
  resumenCorto,
  descripcionDetallada,
  datosEstudiante,
  datosInstitucion,
  intentosPrevios,
}) {
  const agentes = config.agentes.correos;
  if (agentes.length === 0) {
    throw new Error('No hay agentes digitales configurados (AGENTES_DIGITALES)');
  }

  const col = await coleccionEscalamientos();
  const agenteEmail = await elegirAgenteMenosCargado(col);

  const codigo = `CASO-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const motivoLegible = MOTIVOS_LEGIBLES[motivo] || motivo;

  // El asunto lleva el código + un resumen corto para que el agente entienda
  // de qué se trata sin abrir el correo.
  const resumen = String(resumenCorto || '').trim().slice(0, 70);
  const asuntoDelegacion = `[${codigo}] ${motivoLegible}${resumen ? ` — ${resumen}` : ''}`;

  const cuerpoDelegacion = [
    'Hola,',
    'El asistente automático de soporte no pudo resolver este caso y te lo delega. Toda la información que se pudo recopilar del usuario está abajo.',
    seccion('DATOS DEL CASO', `Código: ${codigo}\nMotivo: ${motivoLegible}\nSolicitante: ${remitente}\nAsunto original: ${asunto || '(sin asunto)'}`),
    seccion('QUÉ NECESITA EL USUARIO', descripcionDetallada),
    seccion('DATOS DEL ESTUDIANTE', datosEstudiante),
    seccion('DATOS DE LA INSTITUCIÓN', datosInstitucion),
    seccion('QUÉ INTENTÓ EL ASISTENTE Y POR QUÉ FALLÓ', intentosPrevios),
    'CÓMO RESPONDER\nResponde a ESTE mismo correo con la solución. Tu respuesta se enviará automáticamente al usuario final, en el hilo de correo donde él escribió originalmente — así que redáctala como si le hablaras directamente a él o ella. No hace falta que copies el código del caso.',
    'Soporte Santillana Ecuador (asistente automático)',
  ].join('\n\n');

  const escalamiento = {
    _id: codigo,
    // 'caso' = el asistente no pudo resolverlo (esta función). Los TICKETS crean
    // un registro hermano con tipo 'ticket' (ver registrarDerivacionTicket): usan
    // la MISMA maquinaria de viaje de vuelta, pero se separan en la analítica y
    // en el reparto de carga, que son solo de casos.
    tipo: 'caso',
    // Hilo y mensaje del correo ORIGINAL del cliente (a dónde va la respuesta).
    hiloId,
    mensajeId,
    remitente,
    asuntoOriginal: asunto || '',
    motivo,
    resumenCorto: resumen,
    descripcionDetallada: descripcionDetallada || '',
    datosEstudiante: datosEstudiante || '',
    datosInstitucion: datosInstitucion || '',
    intentosPrevios: intentosPrevios || '',
    agenteEmail,
    estado: 'pendiente_agente',
    // Hilo del correo de DELEGACIÓN (se completa cuando n8n lo envía). Es la
    // llave que permite reconocer la respuesta del agente sin leer el asunto.
    conversationIdDelegacion: null,
    mensajeIdDelegacion: null,
    creadoEn: new Date(),
    respuestaAgente: null,
    respondidoEn: null,
  };
  await col.insertOne(escalamiento);

  return {
    codigo,
    agenteEmail,
    correoDelegacion: {
      para: agenteEmail,
      asunto: asuntoDelegacion,
      cuerpo: cuerpoDelegacion,
      // Correo interno para el agente: sin firma comercial.
      cuerpoHtml: textoAHtml(cuerpoDelegacion, { firma: false }),
    },
  };
}

/**
 * Registro de VIAJE DE VUELTA para un ticket.
 *
 * Un ticket (reseteo de clave, incidencia de plataforma) también necesita que la
 * respuesta de quien lo atiende llegue de vuelta al cliente. En vez de duplicar
 * toda la mecánica, se guarda un registro hermano del de un caso: misma colección,
 * mismo reconocimiento por conversationId, misma resolución. Se distingue por
 * `tipo: 'ticket'` para que NO cuente como escalamiento en la analítica ni en el
 * reparto de casos.
 *
 * El _id es la clave del ticket (PENDIENTE-XXX / la de Jira), así que el aviso al
 * equipo y este registro comparten identificador.
 */
export async function registrarDerivacionTicket({
  jiraKey,
  hiloId,
  mensajeId,
  remitente,
  asuntoOriginal,
  agenteEmail,
  tipoTicket,
  equipo,
}) {
  const col = await coleccionEscalamientos();
  await col.updateOne(
    { _id: jiraKey },
    {
      $setOnInsert: {
        _id: jiraKey,
        tipo: 'ticket',
        tipoTicket: tipoTicket || null,
        equipo: equipo || null,
        // Correo ORIGINAL del cliente: a dónde vuelve la respuesta.
        hiloId,
        mensajeId,
        remitente,
        asuntoOriginal: asuntoOriginal || '',
        // Buzón(es) del equipo/agente que atiende el ticket.
        agenteEmail: agenteEmail || '',
        estado: 'pendiente_agente',
        conversationIdDelegacion: null,
        mensajeIdDelegacion: null,
        creadoEn: new Date(),
        respuestaAgente: null,
        respondidoEn: null,
      },
    },
    { upsert: true }
  );
  return { status: 'OK', jiraKey };
}

/**
 * Guarda el hilo del correo de delegación/aviso que n8n acaba de enviar. Con
 * esto, la respuesta de quien lo atiende se reconoce por conversationId (robusto)
 * y no por el texto del asunto (frágil). Sirve igual para casos y tickets.
 */
export async function registrarHiloDelegacion({ codigo, conversationIdDelegacion, mensajeIdDelegacion }) {
  const col = await coleccionEscalamientos();
  const r = await col.updateOne(
    { _id: codigo },
    { $set: { conversationIdDelegacion: conversationIdDelegacion || null, mensajeIdDelegacion: mensajeIdDelegacion || null } }
  );
  return r.matchedCount > 0
    ? { status: 'OK', codigo }
    : { status: 'CASO_NO_ENCONTRADO', codigo };
}

/**
 * ¿Este correo entrante es la respuesta de un agente a un caso delegado?
 *
 * Orden de detección:
 *  1. conversationId del hilo de delegación (robusto: no depende del asunto).
 *  2. Código CASO-XXXXXX en el asunto (respaldo, por si el paso de registro
 *     falló o el caso se creó antes de esta versión).
 *
 * Devuelve el escalamiento pendiente, o null si es un correo normal de cliente.
 */
export async function buscarEscalamientoPendiente({ hiloId, asunto, remitente }) {
  const col = await coleccionEscalamientos();

  if (hiloId) {
    const porHilo = await col.findOne({ conversationIdDelegacion: hiloId, estado: 'pendiente_agente' });
    if (porHilo) return porHilo;
  }

  // Respaldo por código en el asunto (si el registro del hilo falló). Acepta
  // tanto CASO-XXX como la clave del ticket (PENDIENTE-XXX / Jira).
  const codigo = extraerCodigoDerivacion(asunto);
  if (codigo) {
    const porCodigo = await col.findOne({ _id: codigo, estado: 'pendiente_agente' });
    if (!porCodigo) return null;

    // Guarda: el propio aviso también lleva el código en el asunto, y un cliente
    // podría citarlo al responder. El respaldo solo acepta el correo si viene de
    // quien ATIENDE la derivación (agente o buzón de equipo), no del cliente.
    if (esCorreoDeManejador(remitente, porCodigo)) return porCodigo;
  }

  return null;
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

  // El cliente no debe ver códigos internos (CASO-/PENDIENTE-): se le habla de
  // "su solicitud". El encabezado se adapta a si fue un ticket o un caso.
  const encabezado =
    escalamiento.tipo === 'ticket'
      ? 'Hemos atendido su solicitud. Esta es la respuesta de nuestro equipo:'
      : 'Su solicitud fue atendida por nuestro equipo. Esta es la respuesta:';
  const textoRespuesta =
    `Estimado/a usuario/a:\n\n` +
    `${encabezado}\n\n` +
    `${respuestaAgente}\n\n` +
    `Si necesita algo más, puede responder a este mismo correo.`;

  return {
    status: 'OK',
    codigo,
    hiloId: escalamiento.hiloId,
    mensajeId: escalamiento.mensajeId,
    remitente: escalamiento.remitente,
    textoRespuesta: conFirmaTexto(textoRespuesta),
    textoRespuestaHtml: textoAHtml(textoRespuesta),
  };
}
