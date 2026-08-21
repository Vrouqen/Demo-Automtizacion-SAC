import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { coleccionConsentimientos, coleccionConversaciones } from '../db/mongo.js';
import { extraerEmail, textoAHtml } from '../utils/correo.js';
import { conFirmaTexto } from '../utils/firma.js';
import { validarDocumento } from '../utils/identificacion.js';
import { crearEscalamiento } from './escalamientos.js';

/**
 * Consentimiento de tratamiento de datos personales (LOPDP).
 *
 * IMPORTANTE — el consentimiento de protección de datos NO es lo mismo que
 * aceptar unos términos y condiciones. Un "acepto" suelto no sirve como prueba:
 * la norma exige un registro INDIVIDUAL por consentimiento, que identifique a
 * quien lo otorga, a quién representa, con qué relación, para qué finalidad, y
 * si lo otorgó o no. Este módulo produce exactamente ese registro.
 *
 * El flujo es enteramente por correo (no hay página web ni el mensaje ejecuta
 * nada): el representante responde con "Sí" y los datos que se le piden. Lo que
 * escribe se guarda literal como prueba, junto con los campos ya extraídos.
 *
 * Si no responde dentro del plazo, un job programado delega su solicitud a un
 * agente humano: nadie se queda sin atención por no consentir.
 */

/**
 * Finalidad única del tratamiento. Se registra en cada consentimiento y se
 * enumera en el correo de política, de modo que el "Sí" sea informado: el
 * representante ve los tres tratamientos concretos que cubre antes de aceptar.
 */
export const FINALIDAD =
  'ATENCIÓN DE SOPORTE CON USO DE IA PARA VALIDAR IDENTIDAD Y ENTREGAR CREDENCIALES';

/** Zona horaria del registro: el piloto opera en Ecuador. */
const ZONA = 'America/Guayaquil';

// ── Utilidades de texto ────────────────────────────────────────────────────

const normalizar = (t) =>
  String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

/** Fecha y hora locales, ya separadas como las pide el registro. */
export function fechaHoraLocal(momento = new Date()) {
  const partes = new Intl.DateTimeFormat('es-EC', {
    timeZone: ZONA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
    .formatToParts(momento)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  return {
    fecha: `${partes.day}-${partes.month}-${partes.year}`,
    hora: `${partes.hour}:${partes.minute}`,
  };
}

/**
 * Parte un nombre completo en nombres y apellidos siguiendo la convención
 * ecuatoriana (dos nombres y dos apellidos). Es una heurística: solo se usa
 * cuando el representante escribió todo junto en vez de en campos separados.
 */
function partirNombre(completo) {
  const p = String(completo || '').split(/\s+/).filter(Boolean);
  if (p.length >= 4) return { nombres: p.slice(0, p.length - 2).join(' '), apellidos: p.slice(-2).join(' ') };
  if (p.length === 3) return { nombres: p[0], apellidos: p.slice(1).join(' ') };
  if (p.length === 2) return { nombres: p[0], apellidos: p[1] };
  return { nombres: p.join(' '), apellidos: '' };
}

/** Interpreta un valor como sí / no / indeterminado. */
function interpretarSiNo(valor) {
  const v = normalizar(valor).replace(/[.\s]+$/, '');
  if (!v) return null;
  if (/^(no|no acepto|no autorizo|niego|rechazo)\b/.test(v)) return false;
  if (/^(si|acepto|autorizo|de acuerdo|estoy de acuerdo|conforme|x|v|ok|visto)$/.test(v)) return true;
  if (/^(si|acepto|autorizo)\b/.test(v)) return true;
  return null;
}

/** A qué campo del registro corresponde una etiqueta escrita por el usuario. */
function campoDe(etiqueta) {
  const e = normalizar(etiqueta);
  if (/(parentesco|relacion|vinculo)/.test(e)) return 'parentesco';
  if (/(autoriz|consent|otorg|acept)/.test(e)) return 'otorgado';

  // "del estudiante" manda sobre "del representante": una etiqueta como
  // "Nombres del estudiante" contiene ambas ideas solo si se lee mal.
  const grupo = /(estudiante|representad|alumn|hij[oa]|menor)/.test(e) ? 'representado' : 'representante';

  if (/(cedula|documento|identificacion|pasaporte|\bid\b)/.test(e)) return `${grupo}.cedula`;
  if (/nombre/.test(e) && /apellido/.test(e)) return `${grupo}.completo`;
  if (/apellido/.test(e)) return `${grupo}.apellidos`;
  if (/nombre/.test(e)) return `${grupo}.nombres`;
  return null;
}

/**
 * Intenta leer una línea SIN separador, del tipo "Cédula del estudiante
 * 2300601594": se prueba como etiqueta el prefijo más largo que corresponda a
 * un campo conocido, y el resto es el valor.
 *
 * Los límites de longitud no son decoración: sin ellos, la cláusula de
 * confidencialidad que muchas firmas corporativas llevan al pie empezaría a
 * casar con cualquier campo. Una etiqueta real no pasa de seis palabras ni un
 * valor de ocho.
 */
function asignarSinSeparador(linea, asignar) {
  if (linea.length > 120) return false;

  const palabras = linea.split(/\s+/).filter(Boolean);
  if (palabras.length < 2) return false;

  const maximo = Math.min(6, palabras.length - 1);
  for (let corte = maximo; corte >= 1; corte--) {
    const valor = palabras.slice(corte);
    if (valor.length > 8) continue;

    const campo = campoDe(palabras.slice(0, corte).join(' '));
    if (campo && campo !== 'otorgado') {
      asignar(campo, valor.join(' '));
      return true;
    }
  }
  return false;
}

/**
 * Extrae del correo del representante los datos del consentimiento.
 *
 * Acepta lo que la gente escribe de verdad: campos etiquetados en cualquier
 * orden, con o sin guiones o numeración, nombres y apellidos juntos o
 * separados, y el "Sí" en su propia línea o como valor de una etiqueta.
 *
 * @returns {{otorgado: boolean|null, representante: object, representado: object,
 *            parentesco: string, textoOriginal: string}}
 */
export function parsearConsentimiento(texto) {
  const datos = {
    otorgado: null,
    representante: { nombres: '', apellidos: '', cedula: '' },
    representado: { nombres: '', apellidos: '', cedula: '' },
    parentesco: '',
    textoOriginal: String(texto || '').trim().slice(0, 4000),
  };

  const asignar = (campo, valor) => {
    const v = String(valor || '').trim().replace(/[.;,]+$/, '');
    if (!v) return;

    if (campo === 'parentesco') { datos.parentesco ||= v; return; }
    if (campo === 'otorgado') {
      const si = interpretarSiNo(v);
      if (si !== null) datos.otorgado ??= si;
      return;
    }

    const [grupo, sub] = campo.split('.');
    if (sub === 'completo') {
      const { nombres, apellidos } = partirNombre(v);
      datos[grupo].nombres ||= nombres;
      datos[grupo].apellidos ||= apellidos;
      return;
    }
    datos[grupo][sub] ||= v;
  };

  for (const linea of String(texto || '').split(/\r?\n/)) {
    const limpia = linea.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!limpia) continue;

    const conEtiqueta = limpia.match(/^(.{2,60}?)\s*[:=]\s*(.+)$/);
    if (conEtiqueta) {
      const campo = campoDe(conEtiqueta[1]);
      if (campo) asignar(campo, conEtiqueta[2]);
      continue;
    }

    // Sin dos puntos: "Cédula/ID del representante legal 1725617730". Pasa a
    // menudo cuando el representante reescribe a mano solo lo que le faltaba, y
    // antes se perdía el dato entero.
    if (asignarSinSeparador(limpia, asignar)) continue;

    // Línea suelta: solo puede ser el sí o el no.
    const si = interpretarSiNo(limpia);
    if (si !== null) datos.otorgado ??= si;
  }

  // "Nombres del estudiante: Juan Sebastián Pérez Loor": etiqueta de nombres
  // pero valor con el nombre entero. Si no llegaron apellidos por separado se
  // reparte aquí, en vez de pedirle al representante un dato que ya escribió.
  // Con dos palabras no se toca: no hay forma de saber si "Juan Sebastián" son
  // dos nombres o un nombre y un apellido.
  for (const grupo of ['representante', 'representado']) {
    const persona = datos[grupo];
    if (!persona.apellidos && persona.nombres.split(/\s+/).filter(Boolean).length >= 3) {
      const partido = partirNombre(persona.nombres);
      persona.nombres = partido.nombres;
      persona.apellidos = partido.apellidos;
    }
  }

  // Una negativa escrita en cualquier parte del correo manda sobre todo lo demás.
  if (/\bno\s+(acepto|autorizo|otorgo|estoy de acuerdo|doy mi consentimiento)\b/i.test(texto || '')) {
    datos.otorgado = false;
  }

  return datos;
}

/**
 * Junta los datos de TODOS los correos del representante en este hilo.
 *
 * Es imprescindible: el correo que le pedimos dice "responda indicando
 * únicamente esos datos", así que su segunda respuesta trae solo lo que
 * faltaba. Mirando un mensaje suelto se perdía todo lo anterior y se le volvían
 * a pedir los ocho campos una y otra vez — un bucle del que no salía.
 *
 * Gana el valor más reciente que no venga vacío, de modo que corregir una
 * cédula mal escrita funcione sin tener que repetir el resto.
 */
export function acumularConsentimiento(textos) {
  const total = {
    otorgado: null,
    representante: { nombres: '', apellidos: '', cedula: '' },
    representado: { nombres: '', apellidos: '', cedula: '' },
    parentesco: '',
    textoOriginal: '',
  };

  const partes = [];
  for (const texto of textos) {
    const datos = parsearConsentimiento(texto);
    if (datos.otorgado !== null) total.otorgado = datos.otorgado;
    if (datos.parentesco) total.parentesco = datos.parentesco;
    for (const grupo of ['representante', 'representado']) {
      for (const campo of ['nombres', 'apellidos', 'cedula']) {
        if (datos[grupo][campo]) total[grupo][campo] = datos[grupo][campo];
      }
    }
    if (datos.textoOriginal) partes.push(datos.textoOriginal);
  }

  // La prueba guardada es todo lo que escribió, no solo el último correo.
  total.textoOriginal = partes.join('\n\n--- (siguiente respuesta) ---\n\n').slice(0, 8000);
  return total;
}

/**
 * Comprueba qué falta o está mal en los datos extraídos.
 * @returns {string[]} lista vacía si el consentimiento se puede registrar.
 */
export function validarConsentimiento(datos) {
  const faltan = [];

  if (datos.otorgado !== true) faltan.push('La palabra "Sí" para otorgar el consentimiento');
  if (!datos.representante.nombres) faltan.push('Nombres del representante legal');
  if (!datos.representante.apellidos) faltan.push('Apellidos del representante legal');

  const docRep = validarDocumento(datos.representante.cedula);
  if (docRep.error) faltan.push(`Cédula/ID del representante legal (${docRep.error})`);

  if (!datos.parentesco) faltan.push('Parentesco o relación con el estudiante');
  if (!datos.representado.nombres) faltan.push('Nombres del estudiante');
  if (!datos.representado.apellidos) faltan.push('Apellidos del estudiante');

  const docEst = validarDocumento(datos.representado.cedula);
  if (docEst.error) faltan.push(`Cédula/ID del estudiante (${docEst.error})`);

  return faltan;
}

// ── Textos que ve el representante ─────────────────────────────────────────

const CORREO_SOPORTE = (config.cuentasSoporte && config.cuentasSoporte[0]) || 'soporteecuador@santillana.com';

const CAMPOS_PEDIDOS =
  '- Autorizo: **Sí**\n' +
  '- Nombres del representante legal:\n' +
  '- Apellidos del representante legal:\n' +
  '- Cédula/ID del representante legal:\n' +
  '- Parentesco con el estudiante:\n' +
  '- Nombres del estudiante:\n' +
  '- Apellidos del estudiante:\n' +
  '- Cédula/ID del estudiante:';

/**
 * Correo de política. Enumera los tres tratamientos concretos que cubre el
 * consentimiento, para que el "Sí" sea informado y no una casilla a ciegas.
 */
export function textoPolitica() {
  const horas = config.consentimiento.horasLimite;
  return (
    'Hola, gracias por escribirnos.\n\n' +
    'Antes de gestionar su solicitud necesitamos **su consentimiento para tratar sus datos personales ' +
    'y los del estudiante**, conforme a la Ley Orgánica de Protección de Datos Personales del Ecuador ' +
    '(LOPDP). **Este consentimiento es independiente de cualquier término y condición que haya ' +
    'aceptado antes.**\n\n' +
    `**FINALIDAD**\n${FINALIDAD}\n\n` +
    '**QUÉ TRATAMIENTOS CUBRE**\n' +
    '1. **Uso de un servicio de inteligencia artificial de un tercero (Google)** para leer su correo, ' +
    'validar la identidad del estudiante y preparar la respuesta.\n' +
    '2. **Tratamiento de los datos del estudiante (menor de edad)** para localizar y entregarle sus ' +
    'credenciales de acceso a las plataformas educativas.\n' +
    '3. **Almacenamiento y procesamiento en servidores ubicados fuera del Ecuador**, con las ' +
    'garantías contractuales correspondientes.\n\n' +
    '**SUS DERECHOS**\n' +
    'Puede ejercer sus derechos de **acceso, rectificación y eliminación**, y **retirar este ' +
    'consentimiento en cualquier momento**, escribiendo a ' +
    `${CORREO_SOPORTE}. No compartimos sus datos con terceros ajenos a la prestación del servicio y ` +
    'los conservamos solo el tiempo necesario para atenderle.\n\n' +
    '**PARA CONTINUAR**\n' +
    'Responda a este mismo correo **copiando la siguiente lista y completándola**:\n\n' +
    CAMPOS_PEDIDOS +
    '\n\nSi no desea otorgar el consentimiento, responda **"No acepto"** y su solicitud será atendida ' +
    'igualmente por un agente de nuestro equipo.\n\n' +
    `Si no recibimos su respuesta dentro de las próximas **${horas} horas**, su caso será atendido ` +
    'por un agente, que le responderá en un plazo de **48 a 52 horas**.'
  );
}

/** Se recibió la respuesta pero incompleta: se pide solo lo que falta. */
export function textoFaltanDatos(faltan) {
  return (
    'Gracias por responder.\n\n' +
    'Para poder registrar su consentimiento y continuar con la solicitud, **nos falta lo ' +
    'siguiente**:\n\n' +
    faltan.map((f) => `- **${f}**`).join('\n') +
    '\n\nPuede responder a este mismo correo indicando únicamente esos datos.'
  );
}

/** El representante negó el consentimiento: se le deriva a una persona. */
export function textoRechazo() {
  return (
    'Estimado/a usuario/a:\n\n' +
    'Hemos registrado que **no otorga el consentimiento** para el tratamiento automatizado de los ' +
    'datos. Respetamos su decisión y **no procesaremos su solicitud por medios automáticos**.\n\n' +
    'Su solicitud será atendida **directamente por un agente** de nuestro equipo, que le responderá ' +
    'por este mismo correo en un plazo de **48 a 52 horas**.'
  );
}

/** Texto que se envía al cliente cuando su solicitud se delega por no responder. */
export function textoDelegacionPorNoAceptar() {
  return (
    'Estimado/a usuario/a:\n\n' +
    'No recibimos su consentimiento para el tratamiento de datos dentro del plazo, por lo que su ' +
    'solicitud será atendida **directamente por un agente** de nuestro equipo.\n\n' +
    'Un agente le responderá por este mismo correo en un plazo de **48 a 52 horas**. Si desea que la ' +
    'atención sea **inmediata y automática**, puede enviarnos el consentimiento en cualquier momento.'
  );
}

// ── Registro ───────────────────────────────────────────────────────────────

/**
 * Guarda un consentimiento como registro INDIVIDUAL. Se guarda igual cuando se
 * niega (`otorgado: false`): poder demostrar a qué NO se consintió es parte de
 * lo que exige la norma, y hoy una negativa no dejaba ningún rastro.
 */
export async function registrarConsentimiento({ datos, remitente, hiloId, mensajeId }) {
  const ahora = new Date();
  const { fecha, hora } = fechaHoraLocal(ahora);
  const col = await coleccionConsentimientos();

  const registro = {
    _id: randomUUID(),
    fecha,
    hora,
    zonaHoraria: ZONA,
    otorgadoEn: ahora,
    representante: {
      nombres: datos.representante.nombres,
      apellidos: datos.representante.apellidos,
      cedula: validarDocumento(datos.representante.cedula).valor || '',
      correo: extraerEmail(remitente),
    },
    representado: {
      nombres: datos.representado.nombres,
      apellidos: datos.representado.apellidos,
      cedula: validarDocumento(datos.representado.cedula).valor || '',
    },
    parentesco: datos.parentesco,
    finalidad: FINALIDAD,
    otorgado: datos.otorgado === true,
    // Vigencia solo para el alcance 'cliente'; en alcance 'correo' cada hilo
    // vuelve a pedirlo.
    vigenteHasta: new Date(ahora.getTime() + config.consentimiento.vigenciaDias * 86400000),
    hiloId,
    mensajeId: mensajeId || null,
    // Prueba: el texto tal cual lo escribió el representante.
    textoOriginal: datos.textoOriginal,
  };

  await col.insertOne(registro);
  return registro;
}

// ── Consulta del estado ────────────────────────────────────────────────────

/** Alcance 'cliente': ¿este correo ya otorgó consentimiento vigente? */
export async function tieneConsentimiento(remitente) {
  const email = extraerEmail(remitente);
  if (!email) return false;
  const col = await coleccionConsentimientos();
  const doc = await col.findOne({
    'representante.correo': email,
    otorgado: true,
    $or: [{ vigenteHasta: null }, { vigenteHasta: { $gt: new Date() } }],
  });
  return Boolean(doc);
}

/** Alcance 'correo' (por defecto): la marca vive en la propia conversación. */
export function conversacionTieneConsentimiento(conversacion) {
  return Boolean(conversacion?.consentimientoAceptado);
}

export async function marcarConsentimientoConversacion(hiloId) {
  const col = await coleccionConversaciones();
  await col.updateOne({ _id: hiloId }, { $set: { consentimientoAceptado: true, consentimientoEn: new Date() } });
}

/** Fachada que respeta el alcance configurado. */
export async function yaConsintio({ conversacion, remitente }) {
  return config.consentimiento.porCorreo
    ? conversacionTieneConsentimiento(conversacion)
    : tieneConsentimiento(remitente);
}

/**
 * Procesa la respuesta del representante a la política.
 *
 * @returns {{resultado:'otorgado'|'faltan'|'rechazado', texto?:string, faltan?:string[]}}
 */
export async function procesarRespuestaConsentimiento({ conversacion, hiloId, mensajeId, remitente, cuerpo }) {
  // Se leen todos los correos del representante en el hilo, no solo el último.
  const textos = (conversacion?.mensajes || [])
    .filter((m) => m.rol === 'usuario')
    .map((m) => String(m.cuerpo || ''))
    .filter(Boolean);

  // El correo actual ya suele estar en el historial; si no lo estuviera (por
  // llegar sin mensajeId), se añade para no perderlo.
  if (cuerpo && textos[textos.length - 1] !== cuerpo) textos.push(cuerpo);

  const datos = acumularConsentimiento(textos);

  // Negativa explícita: se registra y se deriva a una persona.
  if (datos.otorgado === false) {
    await registrarConsentimiento({ datos, remitente, hiloId, mensajeId });
    return { resultado: 'rechazado', texto: textoRechazo() };
  }

  const faltan = validarConsentimiento(datos);
  if (faltan.length > 0) return { resultado: 'faltan', faltan, texto: textoFaltanDatos(faltan) };

  const registro = await registrarConsentimiento({ datos, remitente, hiloId, mensajeId });
  if (config.consentimiento.porCorreo) await marcarConsentimientoConversacion(hiloId);

  return { resultado: 'otorgado', registro };
}

// ── Reporte ────────────────────────────────────────────────────────────────

/** Columnas del registro, en el orden exacto exigido. */
export const COLUMNAS_REPORTE = [
  'Fecha',
  'Hora',
  'Nombres (representante legal)',
  'Apellidos (representante legal)',
  'Cédula/ID (representante legal)',
  'Nombres (representado)',
  'Apellidos (representado)',
  'Cédula/ID (representado)',
  'Parentesco/Relación',
  'Finalidad del consentimiento',
  '¿Otorgado?',
];

function fila(r) {
  return [
    r.fecha || '',
    r.hora || '',
    r.representante?.nombres || '',
    r.representante?.apellidos || '',
    r.representante?.cedula || '',
    r.representado?.nombres || '',
    r.representado?.apellidos || '',
    r.representado?.cedula || '',
    r.parentesco || '',
    r.finalidad || '',
    r.otorgado ? 'Sí' : 'No',
  ];
}

/** Registro de consentimientos, del más reciente al más antiguo. */
export async function listarConsentimientos({ desde, hasta, limite = 1000 } = {}) {
  const col = await coleccionConsentimientos();
  const filtro = {};
  if (desde || hasta) {
    filtro.otorgadoEn = {};
    if (desde) filtro.otorgadoEn.$gte = new Date(desde);
    if (hasta) filtro.otorgadoEn.$lte = new Date(hasta);
  }

  const docs = await col
    .find(filtro)
    .sort({ otorgadoEn: -1 })
    .limit(Math.min(Number(limite) || 1000, 5000))
    .toArray();

  return {
    columnas: COLUMNAS_REPORTE,
    total: docs.length,
    otorgados: docs.filter((d) => d.otorgado).length,
    negados: docs.filter((d) => !d.otorgado).length,
    filas: docs.map(fila),
  };
}

/**
 * El mismo registro en CSV, para entregarlo o archivarlo. Se antepone el BOM
 * de UTF-8 porque sin él Excel en Windows abre las tildes y la "ñ" rotas, y
 * este archivo es justamente el que se entrega a auditoría.
 */
export function consentimientosACsv({ columnas, filas }) {
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lineas = [columnas.map(escapar).join(';'), ...filas.map((f) => f.map(escapar).join(';'))];
  return '\uFEFF' + lineas.join('\r\n');
}

// ── Job programado ─────────────────────────────────────────────────────────

/** El último mensaje del CLIENTE con mensajeId (donde hay que responder). */
function ultimoMensajeCliente(conv) {
  return [...(conv.mensajes || [])].reverse().find((m) => m.rol === 'usuario' && m.mensajeId) || null;
}

/** Resumen del hilo del cliente, para documentar la delegación al agente. */
function resumenSolicitud(conv) {
  const textos = (conv.mensajes || [])
    .filter((m) => m.rol === 'usuario')
    .map((m) => String(m.cuerpo || '').trim())
    .filter(Boolean);
  return textos.join('\n---\n').slice(0, 1500) || '(sin contenido)';
}

/**
 * Job programado (lo llama n8n): delega a un agente humano las solicitudes cuyo
 * representante NO respondió dentro del plazo.
 */
export async function delegarConsentimientosVencidos({ horas } = {}) {
  const limiteHoras = horas ? Number(horas) : config.consentimiento.horasLimite;
  const col = await coleccionConversaciones();
  const limite = new Date(Date.now() - limiteHoras * 3600 * 1000);

  const pendientes = await col
    .find({ estado: 'esperando_consentimiento', actualizadoEn: { $lt: limite } })
    .toArray();

  const avisoCliente = textoDelegacionPorNoAceptar();
  const resultados = [];

  for (const conv of pendientes) {
    const ultimo = ultimoMensajeCliente(conv);
    let escalamiento = null;
    try {
      escalamiento = await crearEscalamiento({
        hiloId: conv._id,
        mensajeId: ultimo?.mensajeId || conv.mensajeId,
        remitente: conv.remitente,
        asunto: conv.asunto,
        motivo: 'otro',
        resumenCorto: 'Sin consentimiento de datos — atender solicitud',
        descripcionDetallada:
          'El representante NO envió el consentimiento de tratamiento de datos dentro del plazo. ' +
          'Atiende su solicitud original directamente (SLA 48–52 h). Solicitud del cliente:\n\n' +
          resumenSolicitud(conv),
        datosEstudiante: 'no proporcionado',
        datosInstitucion: 'no proporcionado',
        intentosPrevios: 'Se envió la política de datos y no hubo respuesta en el plazo.',
      });
    } catch (err) {
      console.error('[consentimiento] no se pudo delegar el caso:', err.message);
      continue; // sin destinatario no se puede delegar; se reintenta en la próxima corrida
    }

    await col.updateOne(
      { _id: conv._id },
      {
        $set: { estado: 'esperando_agente', actualizadoEn: new Date() },
        $push: {
          mensajes: { rol: 'asistente', cuerpo: avisoCliente, fecha: new Date() },
          eventos: {
            tipo: 'delegado_por_no_consentir',
            detalle: { codigo: escalamiento.codigo, horas: limiteHoras },
            fecha: new Date(),
          },
        },
      }
    );

    resultados.push({
      hiloId: conv._id,
      mensajeIdCliente: ultimo?.mensajeId || null,
      remitenteCliente: conv.remitente,
      textoRespuesta: conFirmaTexto(avisoCliente),
      textoRespuestaHtml: textoAHtml(avisoCliente),
      escalamiento,
    });
  }

  return resultados;
}
