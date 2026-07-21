import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

// Firma corporativa de Soporte Santillana Ecuador.
//
// Vive en un solo sitio para que TODAS las salidas la usen igual: las respuestas
// del asistente, las plantillas deterministas, la respuesta de un agente digital
// y el correo de cierre por inactividad. Antes cada texto terminaba con su
// propio "Soporte Santillana Ecuador" y bastaba tocar uno para que quedaran
// desalineados.
//
// El modelo NO redacta la firma: se le quita lo que haya escrito al final
// (ver quitarDespedida) y se pega esta. Así los datos de contacto nunca salen
// inventados ni a medias.

const CONTACTO = {
  direccion: 'Av. Simón Bolívar y Vía Nayón. Centro Corporativo Ekopark. Torre 5, piso 5.',
  ciudad: 'Quito, Ecuador',
  correo: 'soporteecuador@santillana.com',
  telefonos: '(02) 3350356 / 3350347 / 3350357',
  webs: ['www.santillana.com.ec', 'www.tiendasantillana.com.ec'],
};

/** Versión en texto plano (la que se guarda en Mongo y ve un cliente sin HTML). */
export const FIRMA_TEXTO = [
  'Saludos Cordiales.',
  '',
  'Soporte Santillana Ecuador.',
  '',
  CONTACTO.direccion,
  CONTACTO.ciudad,
  CONTACTO.correo,
  CONTACTO.telefonos,
  ...CONTACTO.webs,
].join('\n');

// Despedidas que el modelo (o una plantilla antigua) pueda haber dejado al
// final del texto. Se recortan para no duplicar la firma.
const DESPEDIDAS = [
  /(?:\n\s*)?(?:saludos\s+cordiales|atentamente|cordialmente|un\s+saludo|quedamos\s+atentos)\s*[.,:]?\s*$/i,
  /(?:\n\s*)?soporte\s+santillana\s+ecuador\s*[.,]?\s*$/i,
];

/**
 * Quita la despedida y el nombre del remitente del final del texto, tantas
 * veces como aparezcan (el modelo suele escribir las dos líneas seguidas).
 */
export function quitarDespedida(texto) {
  let t = String(texto || '').replace(/\s+$/, '');
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const re of DESPEDIDAS) {
      const nuevo = t.replace(re, '');
      if (nuevo !== t) {
        t = nuevo.replace(/\s+$/, '');
        cambio = true;
      }
    }
  }
  return t;
}

/** Añade la firma canónica al final de un texto plano, sin duplicarla. */
export function conFirmaTexto(texto) {
  return `${quitarDespedida(texto)}\n\n${FIRMA_TEXTO}`;
}

const ENLACE = '#0b5fa5';

function web(url) {
  return `<a href="https://${url}" style="color:${ENLACE};text-decoration:none;">${url}</a>`;
}

/**
 * Tira de logos. Se muestran de dos maneras según config.firma.logos:
 *   'url' (opción B) → servidos por esta misma Lambda en ?logo=<slug>. No toca
 *          n8n. Contra: Outlook de escritorio los oculta hasta que el usuario
 *          pulse "Descargar imágenes".
 *   'cid' (opción A) → adjuntos en línea; se ven aunque el cliente bloquee
 *          imágenes externas, pero exige que n8n los adjunte por Content-ID.
 * Con config.firma.logos vacío no se emite ninguna <img>: es preferible una
 * firma solo de texto a una firma con cuadros rotos.
 */
// Los anchos NO son arbitrarios: cada PNG trae una cantidad distinta de margen
// transparente (loqueleo es 54% lienzo vacío; santillana, 0%), así que igualar
// anchos descuadra el conjunto. Están calculados para que los tres wordmarks
// tengan la MISMA altura de letra (~22 px) y el logo apilado de creo quede a
// ~1,8x de esa altura, como en la firma de referencia.
//
// 22 px es también el techo: por encima, loqueleo (92 px de origen) habría que
// ampliarlo y se vería pixelado.
//
// `alto` va explícito porque Outlook no siempre respeta height:auto y, sin él,
// deforma la imagen mientras carga.
export const LOGOS = [
  { cid: 'logo-santillana', alt: 'Santillana', archivo: 'santillana.png', ancho: 150, alto: 43 },
  { cid: 'logo-loqueleo', alt: 'Loqueleo', archivo: 'loqueleo.png', ancho: 88, alto: 48 },
  { cid: 'logo-compartir', alt: 'Compartir', archivo: 'compartir.png', ancho: 118, alto: 33 },
  { cid: 'logo-richmond', alt: 'Richmond', archivo: 'richmond.png', ancho: 93, alto: 28 },
  // creo es un logo APILADO (icono + "sistemacreo.com" debajo), no un wordmark:
  // a la altura de los demás su texto sería ilegible. Se le da algo más de aire
  // sin que llegue a dominar la tira. Aun así el texto queda muy pequeño; para
  // que se lea de verdad haría falta una versión horizontal del logo.
  { cid: 'logo-creo', alt: 'sistemacreo.com', archivo: 'creo.png', ancho: 52, alto: 47 },
];

// El "slug" es el nombre corto por el que se pide el logo en la URL
// (?logo=santillana), derivado del cid quitándole el prefijo "logo-".
export function slugLogo(cid) {
  return cid.replace(/^logo-/, '');
}

/** Busca un logo por su slug (?logo=santillana). null si no existe. */
export function logoPorSlug(slug) {
  return LOGOS.find((l) => slugLogo(l.cid) === String(slug || '').toLowerCase()) || null;
}

// Los PNG se leen del disco una sola vez por contenedor Lambda y se cachean en
// memoria (en invocaciones calientes ya no tocan disco).
const cacheBytes = new Map();
export function bytesLogo(slug) {
  const l = logoPorSlug(slug);
  if (!l) return null;
  if (!cacheBytes.has(l.cid)) {
    const ruta = fileURLToPath(new URL(`../assets/firma/${l.archivo}`, import.meta.url));
    cacheBytes.set(l.cid, readFileSync(ruta));
  }
  return cacheBytes.get(l.cid);
}

function imagen(nombre) {
  const l = LOGOS.find((x) => x.cid === nombre);
  if (!config.firma.logos || !l) return '';

  // Opción A (cid): el logo viaja adjunto; n8n/Graph lo resuelve por Content-ID.
  // Opción B (url): el logo se sirve desde esta misma Lambda. Si falta la URL,
  // no emitimos <img> — mejor firma de texto que un cuadro roto.
  let src;
  if (config.firma.logos === 'cid') {
    src = `cid:${l.cid}`;
  } else if (config.firma.logos === 'url' && config.firma.cerebroUrl) {
    src = `${config.firma.cerebroUrl}/?logo=${slugLogo(l.cid)}`;
  } else {
    return '';
  }
  return `<img src="${src}" alt="${l.alt}" width="${l.ancho}" height="${l.alto}" style="border:0;display:inline-block;vertical-align:middle;max-width:${l.ancho}px;">`;
}

/**
 * Bloque HTML de la firma. Se escribe con estilos en línea y tablas porque
 * Outlook no aplica hojas de estilo ni soporta flex/grid en el cuerpo del
 * correo.
 */
export function firmaHtml() {
  const logoPrincipal = imagen('logo-santillana');
  const marcas = ['logo-loqueleo', 'logo-compartir', 'logo-richmond', 'logo-creo'].map(imagen).filter(Boolean);

  return (
    '<div style="font-family:\'Segoe UI\',Arial,sans-serif;font-size:14px;line-height:1.5;color:#222222;">' +
      '<p style="margin:0 0 12px 0;">Saludos Cordiales.</p>' +
      '<p style="margin:0 0 16px 0;"><strong>Soporte Santillana Ecuador.</strong></p>' +
      (logoPrincipal ? `<div style="margin:0 0 14px 0;">${logoPrincipal}</div>` : '') +
      '<div style="border-top:1px solid #dddddd;padding-top:12px;font-size:12px;line-height:1.6;color:#555555;">' +
        `<div>${CONTACTO.direccion}</div>` +
        `<div>${CONTACTO.ciudad}</div>` +
        `<div><a href="mailto:${CONTACTO.correo}" style="color:${ENLACE};text-decoration:none;">${CONTACTO.correo}</a></div>` +
        `<div>${CONTACTO.telefonos}</div>` +
        `<div>${CONTACTO.webs.map(web).join(' &nbsp;|&nbsp; ')}</div>` +
      '</div>' +
      (marcas.length > 0
        ? `<div style="margin-top:14px;">${marcas.map((m) => `<span style="margin-right:18px;display:inline-block;">${m}</span>`).join('')}</div>`
        : '') +
    '</div>'
  );
}
