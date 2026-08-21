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
  direccion: 'Vía a Nayón y De Los Granados.',
  edificio: 'Centro Corporativo Ekopark. Torre 5, piso 5.',
  ciudad: 'Quito, Ecuador.',
  telefonos: '(+593) 2 3350 356 / 2 3350 347 / 2 3350 357',
  webs: ['santillana.com.ec', 'www.tiendasantillana.com.ec'],
};

/**
 * Aviso de confidencialidad. Va en CURSIVA al pie de cada correo, por debajo
 * del banner y por encima de la firma.
 */
const CONFIDENCIALIDAD = [
  'La información contenida en este correo electrónico y sus anexos es para uso exclusivo de la ' +
    'persona o entidad a la que va dirigida, ya que puede contener datos que sean privilegiados o ' +
    'confidenciales. Si usted respetado lector no es el destinatario previsto de este mensaje, tenga ' +
    'presente que cualquier proceso de divulgación, distribución o copia está estrictamente ' +
    'prohibido. Si ha recibido el mensaje por error, por favor notifíquelo al correo del cual fue ' +
    'enviado.',
  'Agradecemos su amable atención.',
];

/** Tipografía del correo: Arial 10, como pide la guía de marca. */
export const TIPOGRAFIA_CORREO = "font-family:Arial,Helvetica,sans-serif;font-size:10pt;line-height:1.5;color:#222222;";

/** Versión en texto plano (la que se guarda en Mongo y ve un cliente sin HTML). */
export const FIRMA_TEXTO = [
  'Saludos Cordiales.',
  '',
  'Soporte Santillana Ecuador.',
  '',
  CONTACTO.direccion,
  CONTACTO.edificio,
  CONTACTO.ciudad,
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
 * Quita las marcas de negrita `**así**` que llevan las plantillas.
 *
 * Vive aquí, junto a quitarDespedida, y no en utils/correo.js, porque correo.js
 * ya importa de este módulo: ponerlo allí y usarlo aquí crearía un ciclo. La
 * conversión a <strong> sí vive en correo.js, que es quien arma el HTML.
 */
export function sinMarcasNegrita(texto) {
  return String(texto || '').replace(/\*\*(.+?)\*\*/gs, '$1');
}

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
  // La versión de texto plano no puede llevar negritas, así que se quitan las
  // marcas: al lector le llegaría "**Sí**" en vez de resaltado.
  return `${sinMarcasNegrita(quitarDespedida(texto))}\n\n${FIRMA_TEXTO}`;
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
  // Bloque de firma: Santillana + sello Great Place To Work en una sola pieza,
  // tal como viene del archivo original (204x64). Sustituye a logo-santillana en
  // la firma; ese sigue disponible por separado para otros usos.
  { cid: 'logo-santillana-gptw', alt: 'Santillana · Great Place To Work Certified', archivo: 'santillana-gptw.png', ancho: 200, alto: 63 },
  // Banners de EDI. `bloque: true` los hace FLUIDOS: ocupan el 100 % del ancho
  // disponible y calculan su alto solos, así que se reajustan al zoom y al ancho
  // del panel. `ancho`/`alto` quedan solo como referencia del tamaño natural del
  // archivo (885x98); el render no los usa.
  //
  // Que el archivo sea de 885 px y no de 566 es lo que los mantiene nítidos: con
  // el de 566, que se mostraba a su tamaño exacto, el escalado de pantalla de
  // Windows (125-150 %) lo ampliaba e interpolaba, y por eso se veía borroso.
  { cid: 'banner-edi-cabecera', alt: 'EDI · Ecosistema Digital Integrado 2.0', archivo: 'banner-edi-grande.png', ancho: 885, alto: 98, bloque: true },
  { cid: 'banner-edi-pie', alt: 'Consultas: servicioalclienteec@santillana.com o 1 800 212 000', archivo: 'banner-edi-pie-grande.png', ancho: 885, alto: 98, bloque: true },
];

// El "slug" es el nombre corto por el que se pide la imagen en la URL
// (?logo=santillana), derivado del cid quitándole su prefijo. Se quitan los DOS
// prefijos que se usan —"logo-" y "banner-"— para que la URL sea igual de corta
// en ambos casos: ?logo=edi-cabecera, no ?logo=banner-edi-cabecera.
export function slugLogo(cid) {
  return cid.replace(/^(logo|banner)-/, '');
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

/**
 * ¿El PNG existe en disco? Los banners de EDI se declaran antes de que lleguen
 * los archivos definitivos; sin esta comprobación el correo saldría con cuadros
 * rotos, que es peor que salir sin banner.
 */
function archivoDisponible(l) {
  try {
    bytesLogo(slugLogo(l.cid));
    return true;
  } catch {
    return false;
  }
}

function imagen(nombre) {
  const l = LOGOS.find((x) => x.cid === nombre);
  if (!config.firma.logos || !l || !archivoDisponible(l)) return '';

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
  // Los BANNERS son fluidos: ocupan el 100 % del ancho disponible y calculan su
  // alto solos. Es el "ajuste automático" de Outlook — al ampliar el correo o
  // cambiar el ancho del panel, la imagen acompaña en vez de quedarse fija.
  //
  // Por eso no llevan atributo `height`: con el alto fijado y el ancho al 100 %,
  // Outlook estira la imagen y la deforma. `width="100%"` va también como
  // atributo porque los clientes que ignoran CSS solo miran ese.
  if (l.bloque) {
    return (
      `<img src="${src}" alt="${l.alt}" width="100%" ` +
      'style="border:0;display:block;width:100%;max-width:100%;height:auto;">'
    );
  }

  // Los logos de la firma sí van a tamaño fijo: son pequeños y estirarlos solo
  // los haría borrosos.
  return `<img src="${src}" alt="${l.alt}" width="${l.ancho}" height="${l.alto}" style="border:0;display:inline-block;vertical-align:middle;max-width:${l.ancho}px;">`;
}

/** Banner superior de EDI. Vacío mientras no esté el PNG. */
export function bannerCabeceraHtml() {
  const img = imagen('banner-edi-cabecera');
  return img ? `<div style="margin:0 0 18px 0;">${img}</div>` : '';
}

/**
 * Pie del correo al cliente: banner de contacto de EDI + aviso de
 * confidencialidad en cursiva. Va DEBAJO del cuerpo y ENCIMA de la firma.
 */
export function bannerPieHtml() {
  const img = imagen('banner-edi-pie');
  const confidencial = CONFIDENCIALIDAD.map(
    (p) => `<p style="margin:0 0 10px 0;font-style:italic;font-size:9pt;color:#555555;">${p}</p>`
  ).join('');

  return (
    (img ? `<div style="margin:18px 0 14px 0;">${img}</div>` : '<div style="margin-top:18px;"></div>') +
    `<div style="${TIPOGRAFIA_CORREO}">${confidencial}</div>`
  );
}

/**
 * Bloque HTML de la firma. Se escribe con estilos en línea y tablas porque
 * Outlook no aplica hojas de estilo ni soporta flex/grid en el cuerpo del
 * correo.
 */
export function firmaHtml() {
  // Si el bloque combinado no está, se cae al logo suelto de Santillana.
  const cabecera = imagen('logo-santillana-gptw') || imagen('logo-santillana');
  const marcas = ['logo-compartir', 'logo-richmond', 'logo-creo', 'logo-loqueleo'].map(imagen).filter(Boolean);

  return (
    `<div style="${TIPOGRAFIA_CORREO}">` +
      '<p style="margin:18px 0 12px 0;">Saludos cordiales,</p>' +
      '<p style="margin:0 0 14px 0;"><strong>Soporte Santillana Ecuador</strong></p>' +
      (cabecera ? `<div style="margin:0 0 14px 0;">${cabecera}</div>` : '') +
      '<div style="line-height:1.7;">' +
        `<div>${CONTACTO.direccion}</div>` +
        `<div>${CONTACTO.edificio}</div>` +
        `<div>${CONTACTO.ciudad}</div>` +
        `<div>${CONTACTO.telefonos}</div>` +
        CONTACTO.webs.map((u) => `<div>${web(u)}</div>`).join('') +
      '</div>' +
      (marcas.length > 0
        ? `<div style="margin-top:16px;">${marcas.map((m) => `<span style="margin-right:18px;display:inline-block;">${m}</span>`).join('')}</div>`
        : '') +
    '</div>'
  );
}
