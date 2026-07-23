import { coleccionConversaciones, coleccionEscalamientos, coleccionDescartes } from '../db/mongo.js';
import { cargaPorAgente } from './escalamientos.js';

/**
 * Analítica del piloto.
 *
 * La fuente de verdad son los EVENTOS que cada conversación va acumulando
 * (`eventos[]`), no contadores agregados aparte: así una métrica nueva se puede
 * calcular hacia atrás sobre el histórico, sin haber tenido que preverla. Para
 * el volumen de un piloto (miles de hilos, no millones) leer los documentos y
 * agregar en memoria es más simple y flexible que un pipeline de Mongo, y
 * permite derivar tiempos que dependen del orden de los mensajes.
 *
 * Si el piloto escalara a decenas de miles de hilos, el corte natural sería
 * mover `porDia` y los conteos a un $group en Mongo y mantener aquí solo los
 * cálculos que necesitan recorrer los mensajes.
 */

const MS_HORA = 3600 * 1000;

/** Estados terminales: el hilo ya no espera nada de nadie. */
const ESTADOS_CERRADOS = new Set(['resuelto', 'cerrado', 'cerrado_inactividad']);

function claveDia(fecha) {
  return new Date(fecha).toISOString().slice(0, 10);
}

function incr(obj, clave, n = 1) {
  if (!clave) return;
  obj[clave] = (obj[clave] || 0) + n;
}

/** Percentil sobre una lista ya ordenada de números (interpolación lineal). */
function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  const idx = (ordenados.length - 1) * p;
  const bajo = Math.floor(idx);
  const alto = Math.ceil(idx);
  const valor = bajo === alto ? ordenados[bajo] : ordenados[bajo] + (ordenados[alto] - ordenados[bajo]) * (idx - bajo);
  return +valor.toFixed(2);
}

function resumenTiempos(horas) {
  const ordenados = [...horas].sort((a, b) => a - b);
  return {
    muestras: ordenados.length,
    promedio: ordenados.length > 0 ? +(ordenados.reduce((a, b) => a + b, 0) / ordenados.length).toFixed(2) : null,
    mediana: percentil(ordenados, 0.5),
    p90: percentil(ordenados, 0.9),
  };
}

/**
 * Une los distintos eventos de búsqueda de credenciales en el resultado que
 * tuvo cada intento (los eventos se llaman `credencial_<status>`).
 */
function statusCredencial(tipoEvento) {
  return tipoEvento.startsWith('credencial_') ? tipoEvento.slice('credencial_'.length) : null;
}

export async function obtenerAnalitica({ desde, hasta } = {}) {
  const filtroFecha = {};
  if (desde) filtroFecha.$gte = new Date(desde);
  if (hasta) filtroFecha.$lte = new Date(hasta);
  const rango = Object.keys(filtroFecha).length > 0 ? filtroFecha : null;

  const [colConv, colEsc, colDesc] = await Promise.all([
    coleccionConversaciones(),
    coleccionEscalamientos(),
    coleccionDescartes(),
  ]);

  const [conversaciones, escalamientos, descartes, agentes] = await Promise.all([
    colConv.find(rango ? { creadoEn: rango } : {}).toArray(),
    // Solo CASOS: los tickets viven en la misma colección (comparten el viaje de
    // vuelta) pero se cuentan en la sección de tickets, no aquí.
    colEsc.find({ tipo: { $ne: 'ticket' }, ...(rango ? { creadoEn: rango } : {}) }).toArray(),
    colDesc.find(rango ? { fecha: rango } : {}).toArray(),
    cargaPorAgente(),
  ]);

  const r = {
    generadoEn: new Date().toISOString(),
    rango: { desde: desde || null, hasta: hasta || null },

    volumen: {
      conversaciones: conversaciones.length,
      correosUsuario: 0,
      respuestasAsistente: 0,
      correosBasuraDescartados: descartes.length,
      // Del total de correos que entraron, cuántos fueron ruido.
      porcentajeBasura: 0,
    },

    // Embudo: de todo lo que entró, ¿qué resolvió el asistente solo y qué
    // necesitó a una persona? Es LA métrica del piloto.
    resolucion: {
      atendidas: 0,
      automaticas: 0, // cerradas sin intervención humana
      escaladas: 0,
      cerradasPorInactividad: 0,
      fueraDeAlcance: 0,
      abiertas: 0,
      tasaAutomatizacion: 0, // automaticas / atendidas
    },

    estados: {},
    porDia: {},

    tiemposHoras: {
      primeraRespuesta: null, // llegada del correo -> primera respuesta del asistente
      resolucionHilo: null, // llegada del correo -> cierre del hilo
      respuestaAgente: null, // creación del caso -> respuesta del agente digital
    },

    credenciales: {
      busquedas: 0,
      porResultado: {},
      tasaAcierto: 0, // OK / búsquedas
    },

    tickets: { total: 0, porTipo: {}, porEquipo: {}, porEstado: {} },

    escalamientos: {
      total: escalamientos.length,
      pendientes: 0,
      resueltos: 0,
      porMotivo: {},
      porAgente: agentes,
    },

    basura: { total: descartes.length, porCategoria: {} },

    // Salud del sistema: lo que hay que vigilar para que el piloto no degrade
    // en silencio. Cada uno de estos contadores nació de un fallo real.
    calidad: {
      derivacionesBloqueadasPorFaltaDeInfo: 0,
      ticketsBloqueadosPorFaltaDeInfo: 0,
      promesasSinAccionCorregidas: 0,
      escalamientosFallidos: 0,
      correosTruncados: 0,
      erroresLlmCuota: 0,
      erroresLlm: 0,
    },

    eventosPorTipo: {},
  };

  const horasPrimeraRespuesta = [];
  const horasResolucion = [];

  for (const conv of conversaciones) {
    const mensajes = conv.mensajes || [];
    const delUsuario = mensajes.filter((m) => m.rol === 'usuario');
    const delAsistente = mensajes.filter((m) => m.rol === 'asistente');

    r.volumen.correosUsuario += delUsuario.length;
    r.volumen.respuestasAsistente += delAsistente.length;
    incr(r.estados, conv.estado);
    if (conv.creadoEn) incr(r.porDia, claveDia(conv.creadoEn));

    // Tiempo hasta la primera respuesta.
    if (conv.creadoEn && delAsistente.length > 0 && delAsistente[0].fecha) {
      const h = (new Date(delAsistente[0].fecha) - new Date(conv.creadoEn)) / MS_HORA;
      if (h >= 0) horasPrimeraRespuesta.push(h);
    }
    // Tiempo hasta el cierre del hilo.
    if (conv.creadoEn && conv.actualizadoEn && ESTADOS_CERRADOS.has(conv.estado)) {
      const h = (new Date(conv.actualizadoEn) - new Date(conv.creadoEn)) / MS_HORA;
      if (h >= 0) horasResolucion.push(h);
    }

    for (const t of conv.tickets || []) {
      r.tickets.total++;
      incr(r.tickets.porTipo, t.tipo);
      incr(r.tickets.porEquipo, t.equipo);
      incr(r.tickets.porEstado, t.estado);
    }

    let fueEscalada = false;
    for (const e of conv.eventos || []) {
      incr(r.eventosPorTipo, e.tipo);

      const status = statusCredencial(e.tipo);
      if (status) {
        r.credenciales.busquedas++;
        incr(r.credenciales.porResultado, status);
      }

      switch (e.tipo) {
        case 'escalado_a_agente':
          fueEscalada = true;
          break;
        case 'derivacion_bloqueada_falta_info':
          r.calidad.derivacionesBloqueadasPorFaltaDeInfo++;
          break;
        case 'ticket_bloqueado_falta_info':
          r.calidad.ticketsBloqueadosPorFaltaDeInfo++;
          break;
        case 'promesa_sin_accion_corregida':
          r.calidad.promesasSinAccionCorregidas++;
          break;
        case 'escalamiento_fallido':
        case 'escalamiento_sin_destinatario':
          r.calidad.escalamientosFallidos++;
          break;
        case 'correo_truncado':
          r.calidad.correosTruncados++;
          break;
        case 'error_llm_cuota':
          r.calidad.erroresLlmCuota++;
          break;
        case 'error_llm':
        case 'error_llm_sin_texto':
          r.calidad.erroresLlm++;
          break;
        default:
          break;
      }
    }

    // Embudo. "Atendida" = el asistente llegó a responder algo.
    if (delAsistente.length > 0) {
      r.resolucion.atendidas++;
      if (fueEscalada) r.resolucion.escaladas++;
      else if (conv.estado === 'cerrado_inactividad') r.resolucion.cerradasPorInactividad++;
      else if (conv.estado === 'cerrado') r.resolucion.fueraDeAlcance++;
      else if (conv.estado === 'resuelto') r.resolucion.automaticas++;
      else r.resolucion.abiertas++;
    }
  }

  for (const d of descartes) incr(r.basura.porCategoria, d.categoria);

  const horasRespuestaAgente = [];
  for (const e of escalamientos) {
    incr(r.escalamientos.porMotivo, e.motivo);
    if (e.estado === 'resuelto') {
      r.escalamientos.resueltos++;
      if (e.creadoEn && e.respondidoEn) {
        const h = (new Date(e.respondidoEn) - new Date(e.creadoEn)) / MS_HORA;
        if (h >= 0) horasRespuestaAgente.push(h);
      }
    } else {
      r.escalamientos.pendientes++;
    }
  }

  r.tiemposHoras.primeraRespuesta = resumenTiempos(horasPrimeraRespuesta);
  r.tiemposHoras.resolucionHilo = resumenTiempos(horasResolucion);
  r.tiemposHoras.respuestaAgente = resumenTiempos(horasRespuestaAgente);

  const totalEntrante = r.volumen.correosUsuario + r.volumen.correosBasuraDescartados;
  r.volumen.porcentajeBasura = totalEntrante > 0 ? +((r.volumen.correosBasuraDescartados / totalEntrante) * 100).toFixed(1) : 0;
  r.resolucion.tasaAutomatizacion =
    r.resolucion.atendidas > 0 ? +((r.resolucion.automaticas / r.resolucion.atendidas) * 100).toFixed(1) : 0;
  r.credenciales.tasaAcierto =
    r.credenciales.busquedas > 0 ? +(((r.credenciales.porResultado.ok || 0) / r.credenciales.busquedas) * 100).toFixed(1) : 0;

  // Serie ordenada cronológicamente (el dashboard la dibuja tal cual).
  r.porDia = Object.fromEntries(Object.entries(r.porDia).sort(([a], [b]) => a.localeCompare(b)));

  return r;
}

// ---------------------------------------------------------------------------
// Listado y detalle de conversaciones (para el dashboard: ver qué llegó, en qué
// estado, y abrir el hilo completo). No cambia el esquema: la "categoría" y el
// "resultado" se DERIVAN de los eventos y de las derivaciones al leer, así que
// también aplican a los datos ya guardados.
// ---------------------------------------------------------------------------

function escaparRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "Categoría" legible del hilo, deducida del evento más significativo. El orden
// del arreglo es la prioridad: si un hilo tuvo varios, gana el de más arriba.
const CATEGORIA_POR_EVENTO = [
  ['escalado_a_agente', 'Caso derivado a agente'],
  ['ticket_creado', 'Ticket'],
  ['credencial_ok', 'Credenciales entregadas'],
  ['credencial_homonimos', 'Colegios homónimos'],
  ['credencial_colegio_no_encontrado', 'Colegio no encontrado'],
  ['credencial_estudiante_no_encontrado', 'Estudiante no encontrado'],
  ['credencial_candidatos', 'Varias coincidencias'],
  ['consulta_estudiantes_activos', 'Estudiantes activos'],
  ['pin_info', 'PIN de acceso'],
  ['fuera_de_alcance', 'Fuera de alcance'],
  ['correo_truncado', 'Correo cortado'],
];

function categoriaDesdeEventos(eventos = []) {
  const tipos = new Set(eventos.map((e) => e.tipo));
  for (const [tipo, etiqueta] of CATEGORIA_POR_EVENTO) {
    if (tipos.has(tipo)) return etiqueta;
  }
  return 'Consulta';
}

/**
 * Lista paginada de conversaciones (datos superficiales para la tabla). Permite
 * filtrar por estado y por texto (asunto, remitente o id de hilo), y trae el
 * resumen de derivaciones (ticket/caso) de cada hilo en UNA sola consulta extra
 * (sin N+1).
 */
export async function listarConversaciones({ estado, q, pagina = 1, limite = 25 } = {}) {
  const col = await coleccionConversaciones();
  const colEsc = await coleccionEscalamientos();

  const filtro = {};
  if (estado) filtro.estado = estado;
  if (q && String(q).trim()) {
    const rx = new RegExp(escaparRegex(String(q).trim()), 'i');
    filtro.$or = [{ asunto: rx }, { remitente: rx }, { _id: rx }];
  }

  const lim = Math.min(Math.max(Number(limite) || 25, 1), 100);
  const pag = Math.max(Number(pagina) || 1, 1);

  const total = await col.countDocuments(filtro);
  const docs = await col
    .find(filtro, {
      projection: {
        asunto: 1, remitente: 1, estado: 1, creadoEn: 1, actualizadoEn: 1,
        mensajes: 1, eventos: 1, tickets: 1,
      },
    })
    .sort({ actualizadoEn: -1 })
    .skip((pag - 1) * lim)
    .limit(lim)
    .toArray();

  const ids = docs.map((d) => d._id);
  const derivaciones = ids.length
    ? await colEsc
        .find(
          { hiloId: { $in: ids } },
          { projection: { hiloId: 1, tipo: 1, estado: 1, agenteEmail: 1, motivo: 1 } }
        )
        .toArray()
    : [];
  const porHilo = new Map();
  for (const d of derivaciones) {
    const arr = porHilo.get(d.hiloId) || [];
    arr.push(d);
    porHilo.set(d.hiloId, arr);
  }

  const filas = docs.map((d) => {
    const mensajes = d.mensajes || [];
    const derivs = (porHilo.get(d._id) || []).map((e) => ({
      codigo: e._id,
      tipo: e.tipo || 'caso',
      estado: e.estado,
      agente: e.agenteEmail || null,
    }));
    return {
      id: d._id,
      asunto: d.asunto || '(sin asunto)',
      remitente: d.remitente || '',
      estado: d.estado || 'abierto',
      categoria: categoriaDesdeEventos(d.eventos || []),
      creadoEn: d.creadoEn || null,
      actualizadoEn: d.actualizadoEn || null,
      nMensajes: mensajes.length,
      nTickets: (d.tickets || []).length,
      derivaciones: derivs,
    };
  });

  return { total, pagina: pag, limite: lim, paginas: Math.max(Math.ceil(total / lim), 1), filas };
}

/**
 * Detalle COMPLETO de una conversación: el hilo de mensajes, la línea de tiempo
 * de eventos, los tickets y las derivaciones (caso/ticket) con la respuesta de
 * quien lo atendió.
 *
 * OJO: los mensajes se guardan tal cual se enviaron. Una respuesta de
 * credenciales contiene login y contraseña en texto — esta vista es interna y
 * DEBE ir protegida con DASHBOARD_TOKEN.
 */
export async function obtenerConversacionDetalle(id) {
  const col = await coleccionConversaciones();
  const conv = await col.findOne({ _id: id });
  if (!conv) return null;

  const colEsc = await coleccionEscalamientos();
  const derivaciones = await colEsc.find({ hiloId: id }).toArray();

  return {
    id: conv._id,
    asunto: conv.asunto || '(sin asunto)',
    remitente: conv.remitente || '',
    cuentaSoporte: conv.cuentaSoporte || '',
    estado: conv.estado || 'abierto',
    categoria: categoriaDesdeEventos(conv.eventos || []),
    creadoEn: conv.creadoEn || null,
    actualizadoEn: conv.actualizadoEn || null,
    mensajes: (conv.mensajes || []).map((m) => ({ rol: m.rol, cuerpo: m.cuerpo, fecha: m.fecha || null })),
    eventos: (conv.eventos || []).map((e) => ({ tipo: e.tipo, detalle: e.detalle || null, fecha: e.fecha || null })),
    tickets: (conv.tickets || []).map((t) => ({
      jiraKey: t.jiraKey, tipo: t.tipo, equipo: t.equipo, estado: t.estado,
      descripcion: t.descripcion, enlazadoA: t.enlazadoA || null, creadoEn: t.creadoEn || null,
    })),
    derivaciones: derivaciones.map((e) => ({
      codigo: e._id,
      tipo: e.tipo || 'caso',
      estado: e.estado,
      motivo: e.motivo || e.tipoTicket || null,
      agente: e.agenteEmail || null,
      respuestaAgente: e.respuestaAgente || null,
      respondidoEn: e.respondidoEn || null,
      creadoEn: e.creadoEn || null,
    })),
  };
}
