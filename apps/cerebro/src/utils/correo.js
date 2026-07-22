// Utilidades de saneamiento y formato de correos.
//
// Outlook entrega el cuerpo como HTML y las respuestas incluyen TODO el hilo
// citado debajo ("De: ... Enviado: ..."). Si eso llega tal cual al modelo, en
// cada vuelta el asistente vuelve a leer sus propios mensajes anteriores como
// si fueran del usuario. Aquí se convierte a texto y se corta el hilo citado,
// de modo que al modelo solo llegue lo que el usuario escribió en ESTE correo.

import { firmaHtml, quitarDespedida } from './firma.js';

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

function escaparHtml(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    .map((p) => `<p style="margin:0 0 12px 0;">${escaparHtml(p).replace(/\n/g, '<br>')}</p>`);
  return (
    `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#222222;">` +
    parrafos.join('') +
    `</div>` +
    (firma ? firmaHtml() : '')
  );
}
