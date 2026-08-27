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
export const FINALIDAD = 'Uso de IA para validar identidad';

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

/** Interpreta un valor como sí / no / indeterminado. */
function interpretarSiNo(valor) {
  const v = normalizar(valor).replace(/[.\s]+$/, '');
  if (!v) return null;
  if (/^(no|no acepto|no autorizo|niego|rechazo)\b/.test(v)) return false;
  if (/^(si|acepto|autorizo|de acuerdo|estoy de acuerdo|conforme|x|v|ok|visto)$/.test(v)) return true;
  if (/^(si|acepto|autorizo)\b/.test(v)) return true;
  return null;
}

/**
 * Etiquetas que se reconocen en la respuesta del representante.
 *
 * El orden importa: se prueban de arriba abajo, así que las más específicas van
 * primero. "Nombre y Apellidos del estudiante" tiene que ganarle a "Nombre",
 * y "Cédula Representante" a "Cédula" a secas.
 *
 * Se listan en su forma NORMALIZADA (minúsculas y sin tildes).
 */
const ETIQUETAS = [
  ['otorgado', /autoriz\w*|consient\w*|otorg\w*|acept\w*|consentimiento/],
  ['parentesco', /parentesco|relacion|vinculo/],
  ['solicitud.institucion', /unidad educativa|instituci\w*|colegio|escuela|plantel/],
  ['solicitud.provincia', /provincia/],
  ['solicitud.ciudad', /ciudad|canton/],
  ['solicitud.paralelo', /paralelo|grupo|seccion/],
  ['solicitud.grado', /grado|nivel|curso/],
  ['representado.cedula', /(?:cedula|documento|identificacion|pasaporte|c\.?i\.?|id)\s*(?:de|del|de la)?\s*(?:estudiante|representad\w*|alumn\w*|hij[oa]|menor)/],
  ['representante.cedula', /(?:cedula|documento|identificacion|pasaporte|c\.?i\.?|id)(?:\s*(?:de|del|de la)?\s*(?:representante|padre|madre|solicitante|apoderad\w*)\w*(?:\s*legal)?)?/],
  ['representado.nombre', /nombres?\s*(?:y\s*apellidos?)?\s*(?:de|del|de la)?\s*(?:estudiante|representad\w*|alumn\w*|hij[oa]|menor)/],
  ['representante.nombre', /nombres?\s*(?:y\s*apellidos?)?(?:\s*(?:de|del|de la)?\s*(?:representante|padre|madre|solicitante|apoderad\w*)\w*(?:\s*legal)?)?/],
  ['representado.nombre', /apellidos?\s*(?:de|del|de la)?\s*(?:estudiante|representad\w*|alumn\w*|hij[oa]|menor)/],
  ['representante.nombre', /apellidos?/],
];

// Una sola expresión con todas las etiquetas, para localizarlas dentro de la
// línea sin importar si el usuario puso dos puntos, comas o nada.
const RE_ETIQUETAS = new RegExp(
  '(?:^|[\\s,;.·|-])(' + ETIQUETAS.map(([, re]) => re.source).join('|') + ')\\s*[:=]?\\s*',
  'gi'
);

/** A qué campo corresponde un trozo de texto que ya sabemos que es etiqueta. */
function campoDe(etiqueta) {
  const e = normalizar(etiqueta);
  for (const [campo, re] of ETIQUETAS) {
    if (new RegExp('^(?:' + re.source + ')$', 'i').test(e)) return campo;
  }
  return null;
}

/**
 * Lee una línea localizando las ETIQUETAS por posición, y toma como valor todo
 * lo que va entre una etiqueta y la siguiente.
 *
 * Es lo que permite que estas tres formas den el mismo resultado:
 *   Nombre: Luis          Apellido: Loor
 *   nombre Luis, apellido Loor
 *   Nombre y Apellido Representante Legal Luis Loor
 *
 * Antes se exigían dos puntos y una etiqueta por línea, así que la segunda
 * forma —la que más escribe la gente— se perdía entera.
 */
function leerLinea(linea, asignar) {
  const normalizada = normalizar(linea);
  const encontradas = [...normalizada.matchAll(RE_ETIQUETAS)];
  if (encontradas.length === 0) return false;

  let asignoAlgo = false;
  for (let i = 0; i < encontradas.length; i++) {
    const actual = encontradas[i];
    const campo = campoDe(actual[1]);
    if (!campo) continue;

    // El valor llega hasta donde empieza la siguiente etiqueta.
    const desde = actual.index + actual[0].length;
    const hasta = i + 1 < encontradas.length ? encontradas[i + 1].index : normalizada.length;

    // Se recorta sobre la línea ORIGINAL para conservar tildes y mayúsculas:
    // la normalizada solo sirve para localizar, nunca para guardar.
    const valor = linea.slice(desde, hasta).replace(/^[\s:=-]+|[\s,;.]+$/g, '');
    if (valor) { asignar(campo, valor); asignoAlgo = true; }
  }
  return asignoAlgo;
}

/**
 * Extrae del correo del representante los datos del consentimiento.
 *
 * El nombre se guarda ENTERO en un solo campo, tal como el formulario lo pide
 * ("Nombre y Apellido Representante Legal"): partirlo en nombres y apellidos
 * obligaba a adivinar dónde acaba uno y empieza el otro, y con dos nombres y un
 * apellido —o al revés— se equivocaba.
 */
export function parsearConsentimiento(texto) {
  const datos = {
    otorgado: null,
    representante: { nombre: '', cedula: '' },
    representado: { nombre: '', cedula: '' },
    parentesco: '',
    solicitud: { institucion: '', ciudad: '', provincia: '', grado: '', paralelo: '' },
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
    datos[grupo][sub] ||= v;
  };

  for (const linea of String(texto || '').split(/\r?\n/)) {
    const limpia = linea.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!limpia) continue;

    if (leerLinea(limpia, asignar)) continue;

    // Línea suelta sin etiqueta: solo puede ser el sí o el no.
    const si = interpretarSiNo(limpia);
    if (si !== null) datos.otorgado ??= si;
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
    representante: { nombre: '', cedula: '' },
    representado: { nombre: '', cedula: '' },
    parentesco: '',
    solicitud: { institucion: '', ciudad: '', provincia: '', grado: '', paralelo: '' },
    textoOriginal: '',
  };

  const partes = [];
  for (const texto of textos) {
    const datos = parsearConsentimiento(texto);
    if (datos.otorgado !== null) total.otorgado = datos.otorgado;
    if (datos.parentesco) total.parentesco = datos.parentesco;
    for (const grupo of ['representante', 'representado']) {
      for (const campo of ['nombre', 'cedula']) {
        if (datos[grupo][campo]) total[grupo][campo] = datos[grupo][campo];
      }
    }
    for (const campo of Object.keys(total.solicitud)) {
      if (datos.solicitud[campo]) total.solicitud[campo] = datos.solicitud[campo];
    }
    if (datos.textoOriginal) partes.push(datos.textoOriginal);
  }

  // La prueba guardada es todo lo que escribió, no solo el último correo.
  total.textoOriginal = partes.join('\n\n--- (siguiente respuesta) ---\n\n').slice(0, 8000);
  return total;
}

/**
 * Cuando falta UN SOLO dato y el representante responde a secas —"0928331404",
 * "El paralelo es el A"—, se toma esa respuesta como el dato pedido.
 *
 * Sin esto, un correo sin etiqueta no aportaba nada: se conservaba el valor
 * anterior y se le repetía el MISMO error, incluso citando la cédula vieja que
 * él acababa de corregir. Es un bucle del que el usuario no tiene forma de
 * salir, porque está respondiendo exactamente lo que se le pidió.
 *
 * Solo actúa con un único campo pendiente: con dos o más no habría manera de
 * saber a cuál corresponde lo que escribió.
 */
const RE_SALTO = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const RE_VINETA = /^[\s\-*•]+/;
const RE_NUMERO = /\d[\d.\-\s]{3,14}/;
const RE_NO_DIGITO = /[^0-9]/g;
const RE_CORTESIA = /^(gracias|hola|buen(os|as)|saludos|listo|ok|de acuerdo|correcto|s[ií])\b/i;
const RE_TRAS_VERBO = /(?:es|son)\s+(?:el|la|los|las)?\s*(.+)$/i;

export function completarCampoSuelto(datos, faltan, textoReciente) {
  if (faltan.length !== 1) return false;

  // Se queda con las líneas cortas, que es donde cabe una respuesta suelta; el
  // resto suele ser la firma corporativa.
  const lineas = String(textoReciente || '')
    .split(RE_SALTO)
    .map((l) => l.replace(RE_VINETA, '').trim())
    .filter((l) => l && l.length <= 60);

  const campo = faltan[0];

  if (/C[ée]dula Representante/i.test(campo)) {
    // Un número suelto: es lo que se pidió.
    for (const l of lineas) {
      const m = l.match(RE_NUMERO);
      if (m) {
        const doc = m[0].replace(RE_NO_DIGITO, '');
        if (doc.length >= 5) { datos.representante.cedula = doc; return true; }
      }
    }
    return false;
  }

  // Para el resto vale la primera línea con contenido que no sea una cortesía.
  const util = lineas.find((l) => !RE_CORTESIA.test(l));
  if (!util) return false;

  // "El paralelo es el A" → se queda con lo que va tras el verbo.
  const valor = (util.match(RE_TRAS_VERBO)?.[1] ?? util).trim();
  if (!valor) return false;

  const destino = {
    'Unidad Educativa': () => (datos.solicitud.institucion = valor),
    'Grado': () => (datos.solicitud.grado = valor),
    'Paralelo': () => (datos.solicitud.paralelo = valor),
    'Parentesco': () => (datos.parentesco = valor),
    'Nombre y Apellido Representante Legal': () => (datos.representante.nombre = valor),
    'Nombre y Apellidos del estudiante': () => (datos.representado.nombre = valor),
  }[campo];

  if (!destino) return false;
  destino();
  return true;
}

/**
 * Comprueba qué falta o está mal en los datos extraídos.
 * @returns {string[]} lista vacía si el consentimiento se puede registrar.
 */
export function validarConsentimiento(datos) {
  const faltan = [];

  if (datos.otorgado !== true) faltan.push('La palabra "Sí" para autorizar');
  if (!datos.representante.nombre) faltan.push('Nombre y Apellido Representante Legal');

  const docRep = validarDocumento(datos.representante.cedula);
  if (docRep.error) faltan.push(`Cédula Representante Legal (${docRep.error})`);

  if (!datos.representado.nombre) faltan.push('Nombre y Apellidos del estudiante');
  if (!datos.parentesco) faltan.push('Parentesco');

  // Datos necesarios para localizar las credenciales.
  //
  // La ciudad y la provincia NO se piden en el primer contacto: solo sirven para
  // desempatar cuando hay colegios con el mismo nombre, y exigírselas a todo el
  // mundo alarga cada caso para resolver unos pocos. Si la búsqueda devuelve
  // varias coincidencias, el asistente las pide entonces.
  if (!datos.solicitud.institucion) faltan.push('Unidad Educativa');
  if (!datos.solicitud.grado) faltan.push('Grado');
  if (!datos.solicitud.paralelo) faltan.push('Paralelo');

  return faltan;
}

// ── Textos que ve el representante ─────────────────────────────────────────

const CORREO_SOPORTE = (config.cuentasSoporte && config.cuentasSoporte[0]) || 'soporteecuador@santillana.com';

/** Responsable de protección de datos: es a donde se ejercen los derechos. */
const CORREO_DATOS = config.consentimiento.correoDatos;

const CAMPOS_PEDIDOS =
  'Autoriza:\n' +
  'Nombre y Apellido Representante Legal:\n' +
  'Cédula Representante Legal:\n' +
  'Nombre y Apellidos del estudiante:\n' +
  'Parentesco:\n' +
  'Unidad Educativa:\n' +
  'Grado:\n' +
  'Paralelo:';

/**
 * Referencia de la incidencia que se cita en el correo.
 *
 * Se deriva del identificador del hilo, así que es ESTABLE: el mismo hilo
 * produce siempre la misma referencia sin necesidad de guardarla ni de un
 * contador central. Es un número para que el representante y el agente hablen
 * del mismo caso, no una clave.
 */
export function referenciaSoporte(hiloId) {
  let h = 0;
  for (const c of String(hiloId || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `SSE-${String(h % 1000000).padStart(6, '0')}`;
}

/**
 * Correo de política. El texto legal lo proporciona Santillana; aquí solo se
 * interpolan la referencia de la incidencia y el enlace a la política, y se
 * marcan en negrita las partes que el cliente indicó.
 */
export function textoPolitica({ hiloId } = {}) {
  const enlace = config.consentimiento.politicaUrl;
  // Sin URL configurada no se escribe un enlace roto: se remite al correo del
  // responsable de datos, que siempre existe.
  const dondeConsultar = enlace
    ? `en el siguiente enlace: ${enlace}`
    : `escribiendo a ${CORREO_DATOS}`;

  return (
    'Estimado/a,\n\n' +
    'Le saludamos de Soporte Santillana Ecuador, su requerimiento está siendo atendido en la ' +
    `incidencia **${referenciaSoporte(hiloId)}**.

` +
    '"Sistemas Educativos de Enseñanza S.A.S. en su calidad de responsable del tratamiento en ' +
    'cumplimiento de la LOPD cumple con informarle que utilizará los datos personales de los ' +
    'usuarios representantes para atender las solicitudes de recuperación de credenciales y para la ' +
    'gestión de incidencias en la plataforma.\n' +
    'Asimismo, con base en su consentimiento, Sistemas Educativos de Enseñanza S.A.S utilizará los ' +
    'datos personales de sus representados (hijo/hija menor de edad) para emplear sistemas de ' +
    'inteligencia artificial que permitan validar la identidad del solicitante y gestionar su ' +
    'solicitud de recuperación de credenciales.\n' +
    'Puedes consultar toda la información relacionada con el tratamiento de tus datos personales o ' +
    `sobre cómo ejercer tus derechos ${dondeConsultar}."

` +
    '**¿Consiente el uso de los datos personales de su representado, mediante herramientas de ' +
    'inteligencia artificial, para validar su identidad y confirmar el vínculo entre ustedes?**\n' +
    "Si está de acuerdo, responda **'Sí'** al presente correo electrónico, con los siguientes datos " +
    'para brindar solución a su requerimiento\n\n' +
    CAMPOS_PEDIDOS +
    '\n\n**Autorizar la validación automatizada de la identidad de tu representado nos permite ' +
    'resolver tu solicitud en menor tiempo. Si prefieres no hacerlo, tu solicitud será igualmente ' +
    'atendida mediante un proceso de verificación manual, cuyo tiempo de respuesta puede superar ' +
    'las 72 horas.**\n\n' +
    'Puedes ejercer alguno de tus derechos en datos personales o retirar tu consentimiento en ' +
    'cualquier momento siguiendo las instrucciones de la política de protección de datos personales ' +
    `en el correo ${CORREO_DATOS}`
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
    'Su solicitud será atendida **directamente por un agente** de nuestro equipo, mediante un proceso ' +
    'de **verificación manual** cuyo tiempo de respuesta **puede superar las 72 horas**.'
  );
}

/**
 * Texto que recibe el cliente cuando vence el plazo sin consentimiento.
 *
 * Además de avisar de la delegación, le PIDE que describa su problema: sin
 * consentimiento no se pudo tratar ningún dato, así que lo único que el agente
 * va a tener es lo que el cliente escriba ahora.
 */
export function textoDelegacionPorNoAceptar() {
  return (
    'Estimado/a usuario/a:' + '\n\n' +
    'No recibimos su consentimiento para el tratamiento automatizado de datos dentro del plazo, así ' +
    'que su solicitud pasa a un **agente digital de servicio**, que la atenderá mediante verificación ' +
    'manual.' + '\n\n' +
    '**Para que podamos resolverla cuanto antes, responda a este mismo correo describiendo:**\n' +
    '- Qué necesita exactamente y para qué\n' +
    '- Desde cuándo tiene el problema y qué mensaje de error ve, si aplica\n' +
    '- Nombre del estudiante, unidad educativa, grado y paralelo' + '\n\n' +
    'Le responderemos por este mismo correo mediante un proceso de **verificación manual**, cuyo tiempo ' +
    'de respuesta **puede superar las 72 horas**.' + '\n\n' +
    'Si prefiere la atención **inmediata y automática**, puede enviarnos el consentimiento en ' +
    'cualquier momento.'
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
    // El nombre va ENTERO en un solo campo, como lo pide el formulario. Partirlo
    // en nombres y apellidos obligaba a adivinar dónde acaba uno y empieza el
    // otro, y con dos nombres y un apellido —o al revés— se equivocaba.
    representante: {
      nombre: datos.representante.nombre,
      cedula: validarDocumento(datos.representante.cedula).valor || '',
      correo: extraerEmail(remitente),
    },
    representado: {
      nombre: datos.representado.nombre,
      // El registro ya no exige la cédula del representado; se guarda solo si
      // el representante la aportó por su cuenta.
      cedula: validarDocumento(datos.representado.cedula).valor || '',
    },
    parentesco: datos.parentesco,
    // Datos del colegio recogidos en el mismo correo. No forman parte del
    // registro legal, pero evitan volver a preguntárselos para la búsqueda.
    solicitud: datos.solicitud,
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

  let faltan = validarConsentimiento(datos);

  // Si solo falta un dato y el último correo trae una respuesta suelta —sin
  // etiqueta—, se toma como ese dato y se vuelve a validar.
  if (faltan.length === 1 && completarCampoSuelto(datos, faltan, textos[textos.length - 1])) {
    faltan = validarConsentimiento(datos);
  }

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
  'Nombre y Apellido (Representante legal)',
  'Cédula (Representante legal)',
  'Nombres y Apellidos (Representado)',
  'Parentesco',
  'Finalidad del Consentimiento',
  '¿Otorgado?',
];

function fila(r) {
  return [
    r.fecha || '',
    r.hora || '',
    r.representante?.nombre || '',
    r.representante?.cedula || '',
    r.representado?.nombre || '',
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

    // Aunque no completara el consentimiento, puede haber respondido a medias.
    // Todo lo que llegó a escribir va al agente: es la diferencia entre que
    // pueda empezar a trabajar y que tenga que escribirle otra vez al cliente.
    const parcial = acumularConsentimiento(
      (conv.mensajes || []).filter((m) => m.rol === 'usuario').map((m) => String(m.cuerpo || ''))
    );
    const nombreEstudiante = parcial.representado.nombre;
    const institucion = [parcial.solicitud.institucion, parcial.solicitud.ciudad, parcial.solicitud.provincia]
      .filter(Boolean).join(', ');
    const grados = [parcial.solicitud.grado && `Grado: ${parcial.solicitud.grado}`,
                    parcial.solicitud.paralelo && `Paralelo: ${parcial.solicitud.paralelo}`]
      .filter(Boolean).join(' — ');

    let escalamiento = null;
    try {
      escalamiento = await crearEscalamiento({
        hiloId: conv._id,
        mensajeId: ultimo?.mensajeId || conv.mensajeId,
        remitente: conv.remitente,
        asunto: conv.asunto,
        motivo: 'otro',
        resumenCorto: nombreEstudiante
          ? `Sin consentimiento — ${nombreEstudiante}`.slice(0, 70)
          : 'Sin consentimiento de datos — atender solicitud',
        descripcionDetallada:
          'El representante NO envió el consentimiento dentro del plazo, así que la identidad NO se ' +
          'validó automáticamente: verifícala tú antes de entregar nada. Atiende su solicitud ' +
          'directamente (el tiempo de respuesta puede superar las 72 h).\n\nLO QUE ESCRIBIÓ EL CLIENTE:\n' +
          resumenSolicitud(conv),
        datosEstudiante: [nombreEstudiante, grados].filter(Boolean).join(' — ') || 'no proporcionado',
        datosInstitucion: institucion || 'no proporcionado',
        intentosPrevios:
          'Se envió la política de datos y no hubo consentimiento en el plazo. Al cliente se le ha ' +
          'pedido que describa su problema en este mismo hilo.',
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
