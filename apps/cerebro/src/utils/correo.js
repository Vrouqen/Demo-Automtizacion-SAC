// Utilidades de saneamiento y formato de correos.
//
// Outlook entrega el cuerpo como HTML y las respuestas incluyen TODO el hilo
// citado debajo ("De: ... Enviado: ..."). Si eso llega tal cual al modelo, en
// cada vuelta el asistente vuelve a leer sus propios mensajes anteriores como
// si fueran del usuario. Aquí se convierte a texto y se corta el hilo citado,
// de modo que al modelo solo llegue lo que el usuario escribió en ESTE correo.

import {
  firmaHtml,
  quitarDespedida,
  bannerCabeceraHtml,
  bannerPieHtml,
  TIPOGRAFIA_CORREO,
} from './firma.js';

const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iquest: '¿', iexcl: '¡',
};

function decodificarEntidades(texto) {
  return texto
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, nombre) => ENTIDADES[nombre] ?? m);
}

/**
 * Extrae la dirección de correo "limpia" de un remitente que puede venir como
 * "Nombre Apellido <correo@dominio>" o ya como "correo@dominio". Se usa para
 * comparar remitentes sin que el nombre para mostrar rompa la igualdad (de ahí
 * que se compare siempre en minúsculas).
 */
export function extraerEmail(valor) {
  const s = String(valor || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

export function pareceHtml(texto) {
  return /<\s*(html|body|div|p|br|span|table|head|meta|font)\b/i.test(String(texto || ''));
}

/** Convierte HTML de correo a texto plano legible. */
export function htmlATexto(html) {
  let t = String(html || '');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n');
  t = t.replace(/<li\b[^>]*>/gi, '- ');
  t = t.replace(/<hr\b[^>]*>/gi, '\n----------\n');
  t = t.replace(/<[^>]+>/g, '');
  t = decodificarEntidades(t);
  // Normaliza espacios: colapsa espacios horizontales, máximo una línea en blanco.
  t = t.replace(/\r/g, '');
  t = t
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// Marcadores donde empieza el hilo citado (Outlook/Gmail, español e inglés).
const SEPARADORES_HILO = [
  /^_{10,}\s*$/m,                                  // divisor "________" de Outlook
  /^-{3,}\s*Mensaje original\s*-{3,}/im,
  /^-{3,}\s*Original Message\s*-{3,}/im,
  /^\s*De:\s.+$/m,                                 // bloque "De: ... Enviado: ... Para: ..."
  /^\s*From:\s.+$/m,
  /^\s*El\s.{5,120}\bescribi[oó]:\s*$/m,           // "El [fecha], X escribió:"
  /^\s*On\s.{5,120}\bwrote:\s*$/m,
];

/**
 * Deja solo el mensaje NUEVO de un correo: convierte HTML a texto si hace
 * falta y corta el hilo citado en el primer separador que encuentre.
 */
export function limpiarCuerpoCorreo(cuerpo) {
  let texto = pareceHtml(cuerpo) ? htmlATexto(cuerpo) : String(cuerpo || '').replace(/\r/g, '').trim();

  let corte = -1;
  for (const sep of SEPARADORES_HILO) {
    const m = texto.match(sep);
    // index > 0: si el correo EMPIEZA con el separador no hay mensaje nuevo
    // que rescatar cortando ahí (se dejaría vacío).
    if (m && m.index > 0 && (corte === -1 || m.index < corte)) corte = m.index;
  }
  if (corte > 0) texto = texto.slice(0, corte).trim();

  // Quita divisores huérfanos al final (p.ej. el <hr> de Outlook que precede
  // al bloque citado queda como una línea de guiones tras el corte).
  texto = texto.replace(/(\n[-_ ]{3,})+\s*$/g, '').trim();

  // Cota de tamaño: los correos con firmas/tablas enormes no deben inflar el
  // prompt. 6000 caracteres es más que suficiente para una consulta de soporte.
  if (texto.length > 6000) texto = texto.slice(0, 6000) + '\n[...correo truncado...]';
  return texto;
}

// Saludo inicial del agente ("Buenas tardes estimad@,", "Hola,", "Estimado:")
// en la PRIMERA línea. Se quita para no duplicar el "Estimado/a usuario/a:" que
// pone el envoltorio al reenviar la respuesta al cliente.
const SALUDO_INICIAL_AGENTE =
  /^\s*(buen(?:os|as)\s+(?:d[ií]as|tardes|noches)|hola|estimad[oa@]s?|apreciad[oa]s?|cordial(?:es)?\s+saludos?|un\s+cordial\s+saludo|reciba\s+un\s+cordial\s+saludo)\b[^\n]*\n+/i;

// Despedida del agente y todo lo que va DESPUÉS (nombre, cargo, firma personal).
// Se corta desde la línea de cierre hasta el final. El envoltorio pone luego la
// despedida y la firma corporativa canónicas.
const DESPEDIDA_AGENTE_A_FIN =
  /(?:^|\n)\s*(saludos\s+cordiales|atentamente|cordialmente|un\s+saludo|saludos|quedo\s+atent[oa]|gracias\s+por\s+su\s+atenci[óo]n|qued[oa]mos\s+atent[oa]s?)\b[\s\S]*$/i;

/**
 * Deja SOLO el contenido útil de la respuesta de un agente digital: quita su
 * saludo inicial y su despedida/firma personal. Así, al reenviar la respuesta
 * al cliente, no se acumulan dos saludos ni dos firmas (la del agente y la
 * corporativa que agrega el envoltorio).
 *
 * Se aplica DESPUÉS de limpiarCuerpoCorreo (que ya cortó el hilo citado).
 */
export function limpiarRespuestaAgente(texto) {
  let t = String(texto || '').replace(/\r/g, '').trim();
  t = t.replace(SALUDO_INICIAL_AGENTE, '');
  t = t.replace(DESPEDIDA_AGENTE_A_FIN, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function escaparHtml(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Marcas de negrita en los correos.
 *
 * Las plantillas del sistema escriben lo importante entre `**dobles
 * asteriscos**` y aquí se convierte en <strong>. Se aplica DESPUÉS de escapar,
 * de modo que sea imposible inyectar HTML desde el texto: lo único que puede
 * producir etiquetas es esta función.
 *
 * El modelo tiene prohibido usar asteriscos (ver el prompt), así que las
 * negritas quedan bajo control de las plantillas y no dependen de que la IA
 * acierte con el formato.
 */
export function aNegritas(textoEscapado) {
  return String(textoEscapado || '').replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
}


/**
 * Convierte texto plano (con \n) al HTML que Outlook renderiza: párrafos con
 * margen y <br> para saltos simples. Graph interpreta el cuerpo del reply como
 * HTML, así que sin esto los \n colapsan en un solo bloque de texto.
 *
 * `firma: true` (por defecto) recorta la despedida que venga en el texto y pega
 * en su lugar la firma corporativa maquetada. Los correos internos —la
 * delegación a un agente digital— la piden en false: ahí la firma comercial
 * sobra.
 */
export function textoAHtml(texto, { firma = true } = {}) {
  const cuerpo = firma ? quitarDespedida(texto) : texto;
  const parrafos = String(cuerpo || '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 12px 0;">${aNegritas(escaparHtml(p)).replace(/\n/g, '<br>')}</p>`
    );
  // Los correos al cliente van con la imagen de marca completa: banner de EDI
  // arriba, cuerpo, banner de contacto + confidencialidad, y firma. Los correos
  // INTERNOS (delegación a un agente, aviso de ticket) van sin nada de eso:
  // son de trabajo, no comerciales, y el banner solo estorbaría.
  return (
    (firma ? bannerCabeceraHtml() : '') +
    `<div style="${TIPOGRAFIA_CORREO}">` +
    parrafos.join('') +
    `</div>` +
    (firma ? bannerPieHtml() + firmaHtml() : '')
  );
}
