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
