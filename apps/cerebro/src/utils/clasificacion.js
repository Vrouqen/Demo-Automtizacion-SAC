// Clasificación de correos NO atendibles (basura) antes de gastar una llamada
// al modelo.
//
// El buzón de soporte recibe, además de consultas reales, publicidad
// (promociones de servicios, newsletters), notificaciones automáticas de
// plataformas, respuestas automáticas de "fuera de la oficina" y rebotes de
// entrega. Responderlos es, en el mejor caso, ruido; en el peor, un bucle de
// correos automáticos entre dos robots.
//
// Criterio: es preferible dejar pasar un correo dudoso (lo atiende el asistente)
// que descartar una consulta real. Por eso solo se descarta con señales fuertes
// o con varias señales de publicidad a la vez, y nunca cuando el texto contiene
// una intención de soporte clara.

/** Remitentes de los que jamás llega una consulta real (buzones no atendidos). */
const REMITENTE_AUTOMATICO =
  /^(no[-._]?reply|noreply|donotreply|do[-._]?not[-._]?reply|notifica(?:tions?|ciones)?|notify|mailer[-._]?daemon|postmaster|bounce[sd]?|newsletter|boletin|marketing|mailing|promo(?:ciones)?|ofertas|campaigns?|alerts?|automated?|automatic[oa]|noresponder|no[-._]?responder)([-._+][a-z0-9-]+)?@/i;

/** Dominios de envío masivo (ESP): nunca son un padre de familia escribiendo. */
const DOMINIO_MASIVO =
  /@([a-z0-9-]+\.)*(sendgrid\.(net|com)|mailchimp\.com|mcsv\.net|mailchimpapp\.net|mktomail\.com|marketo\.com|mailgun\.(org|net)|sparkpostmail\.com|amazonses\.com|sendinblue\.com|brevo\.com|hubspot(email)?\.(com|net)|salesforce\.com|exacttarget\.com|mailjet\.com|constantcontact\.com|klaviyomail\.com|rsgsv\.net)$/i;

/** Asuntos de rebote / entrega fallida. */
const ASUNTO_REBOTE =
  /(^|\b)(undeliverable|undelivered mail|delivery (status notification|has failed|failure)|mail delivery (failed|subsystem)|returned mail|no se pudo entregar|correo no entregado|error de entrega|devoluci[óo]n de correo)\b/i;

/** Asuntos / cuerpos de respuesta automática de ausencia. */
const RESPUESTA_AUTOMATICA =
  /(^|\b)(automatic reply|auto[-\s]?reply|out of office|respuesta autom[áa]tica|fuera de la oficina|estar[ée] fuera de la oficina|ausencia temporal|vacation reply)\b/i;

/**
 * Señales de correo publicitario / newsletter. Cada una suma un punto; hacen
 * falta DOS para descartar (una sola aparece a veces en correos legítimos).
 */
const SENALES_PUBLICIDAD = [
  // Pie de lista de distribución: la señal más confiable de envío masivo.
  /\b(unsubscribe|cancelar (?:la )?suscripci[óo]n|darse de baja|dar de baja|baja de esta lista|gestionar (?:mis )?preferencias|preferencias de (?:correo|suscripci[óo]n)|manage (?:your )?preferences|email preferences)\b/i,
  /\b(ver (?:este )?(?:correo|mensaje|boletín) en (?:el|tu) navegador|view (?:this email )?in browser|no responda a este (?:correo|mensaje)|este (?:es un )?(?:correo|mensaje) autom[áa]tico, no lo responda|this is an automated (?:message|email))\b/i,
  // Llamadas a la acción típicas de campaña.
  /\b(reg[íi]strate ahora|inscr[íi]bete (?:ya|ahora)|comienza (?:gratis|ahora)|empieza (?:gratis|ahora)|obt[ée]n (?:tu|el|gratis)|act[íi]valo ahora|solicita (?:tu|ya)|reclama (?:tu|ya)|descarga (?:gratis|ahora)|sign up (?:now|today)|get started (?:free|now|today)|claim your|start (?:your )?free (?:trial|account)|learn more|shop now|buy now)\b/i,
  // Gancho comercial.
  /\b(oferta (?:especial|exclusiva|limitada)|descuento(?:s)? del? \d|promoci[óo]n (?:especial|exclusiva|v[áa]lida)|precio especial|[úu]ltima oportunidad|por tiempo limitado|gratis por \d|cr[ée]dito(?:s)? gratis|free credit|special offer|limited time|% de descuento|\d+% off)\b/i,
  // Marketing de producto/eventos (el caso "Azure for Students" cae aquí).
  /\b(webinar|newsletter|bolet[íi]n (?:informativo|mensual|semanal)|[úu]nete al evento|[úu]nete a (?:la|nuestra) comunidad|s[íi]guenos en|prueba gratuita|free trial|plan (?:premium|pro|business)|licencia(?:s)? gratuita(?:s)?|beneficios? exclusivos?)\b/i,
];

/**
 * Intención de soporte inequívoca. Si aparece, el correo se atiende aunque
 * arrastre alguna señal publicitaria (p. ej. la firma corporativa del colegio
 * con "síguenos en" al pie).
 */
const INTENCION_SOPORTE =
  /\b(credencial(?:es)?|contrase[ñn]a|clave de acceso|usuario y contrase[ñn]a|no me acuerdo|olvid[ée] (?:mi|la)|resete[oa]r?|restablecer|\bpin\b|compartir|creo|no puedo (?:ingresar|entrar|acceder)|no veo (?:el|mis|las)|no me carga|no aparece|unidad educativa|instituci[óo]n educativa|colegio|estudiante|alumn[oa]|representante|paralelo|libro)\b/i;

function localPartYDominio(remitente) {
  const dir = String(remitente || '').trim().toLowerCase();
  const m = dir.match(/<([^>]+)>/); // "Nombre <correo@dominio>"
  return m ? m[1] : dir;
}

/**
 * Decide si un correo entrante debe descartarse sin responder.
 *
 * @returns {{categoria: string, senal: string}|null} null = atenderlo normalmente.
 */
export function clasificarCorreoBasura({ remitente, asunto, cuerpo }) {
  const dir = localPartYDominio(remitente);
  const asuntoTxt = String(asunto || '');
  const cuerpoTxt = String(cuerpo || '');
  const texto = `${asuntoTxt}\n${cuerpoTxt}`;

  // --- Señales fuertes: descartan por sí solas ---
  if (ASUNTO_REBOTE.test(asuntoTxt)) {
    return { categoria: 'rebote', senal: 'asunto de entrega fallida' };
  }
  if (RESPUESTA_AUTOMATICA.test(asuntoTxt) || RESPUESTA_AUTOMATICA.test(cuerpoTxt.slice(0, 400))) {
    return { categoria: 'respuesta_automatica', senal: 'aviso de ausencia / auto-reply' };
  }
  if (REMITENTE_AUTOMATICO.test(dir)) {
    return { categoria: 'remitente_automatico', senal: `buzón no atendido (${dir})` };
  }
  if (DOMINIO_MASIVO.test(dir)) {
    return { categoria: 'envio_masivo', senal: `dominio de envío masivo (${dir})` };
  }

  // --- Publicidad: hacen falta dos señales, y ninguna intención de soporte ---
  if (INTENCION_SOPORTE.test(texto)) return null;

  const senales = SENALES_PUBLICIDAD.filter((re) => re.test(texto)).length;
  if (senales >= 2) {
    return { categoria: 'promocional', senal: `${senales} señales de correo publicitario` };
  }

  return null;
}
