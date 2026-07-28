import { config } from '../config.js';
import { coleccionConsentimientos, coleccionConversaciones } from '../db/mongo.js';
import { extraerEmail, textoAHtml } from '../utils/correo.js';
import { conFirmaTexto } from '../utils/firma.js';
import { crearEscalamiento } from './escalamientos.js';

/**
 * Consentimiento de tratamiento de datos.
 *
 * Antes de atender la solicitud de un cliente, este debe ACEPTAR la política.
 * La aceptación se hace por correo (el cliente responde "ACEPTO"): no hace falta
 * ninguna página web ni que el correo ejecute nada — encaja en el plan gratuito.
 * La aceptación se guarda por dirección de correo (una sola vez, con vigencia),
 * no en cada solicitud, para no repetir la política una y otra vez.
 *
 * Si el cliente no acepta dentro del plazo (config.consentimiento.horasLimite),
 * un job programado delega su solicitud a un agente humano (SLA 48–52 h) y se lo
 * comunica.
 */

// Negación explícita: "no acepto", "no estoy de acuerdo", "no autorizo".
const RE_NIEGA = /\bno\s+(acepto|aceptamos|estoy de acuerdo|estamos de acuerdo|autorizo)\b/i;
// Señal de aceptación.
const RE_ACEPTA =
  /\b(acepto|aceptamos|de acuerdo|estoy de acuerdo|estamos de acuerdo|autorizo el tratamiento|autorizo)\b/i;

/**
 * ¿El texto del cliente es una ACEPTACIÓN de la política?
 *
 * Reglas para evitar falsos positivos:
 *  - Si niega explícitamente ("no acepto") → false.
 *  - Solo cuenta en un mensaje CORTO (la respuesta "ACEPTO", "sí, acepto la
 *    política"…), no cuando "acepto" aparece enterrado en un correo largo.
 * Se evalúa sobre el mensaje ya limpio (sin el hilo citado debajo).
 */
export function esAceptacion(texto) {
  const t = String(texto || '').trim();
  if (!t || RE_NIEGA.test(t)) return false;
  if (t.length > 60) return false;
  return RE_ACEPTA.test(t);
}

const CORREO_SOPORTE = (config.cuentasSoporte && config.cuentasSoporte[0]) || 'soporteecuador@santillana.com';

/**
 * Texto del correo de política que se envía al cliente. Es un RESUMEN operativo;
 * reemplázalo por el texto legal oficial (ver docs/Cumplimiento_LOPDP_Piloto_SAC).
 * Termina pidiendo responder ACEPTO — la firma corporativa la añade el envoltorio.
 */
export function textoPolitica() {
  const horas = config.consentimiento.horasLimite;
  return (
    'Hola, gracias por escribirnos.\n\n' +
    'Antes de gestionar tu solicitud necesitamos tu autorización para tratar tus datos personales y ' +
    'los del estudiante, conforme a la Ley Orgánica de Protección de Datos Personales del Ecuador (LOPDP).\n\n' +
    'CÓMO TRATAMOS TUS DATOS\n' +
    '- Finalidad: atender tu solicitud de soporte (entregar credenciales, resolver incidencias de las ' +
    'plataformas educativas).\n' +
    '- Datos que usamos: tu correo, el nombre del estudiante, su unidad educativa, nivel y paralelo.\n' +
    '- No compartimos tus datos con terceros ajenos a la prestación del servicio, y los conservamos solo ' +
    'el tiempo necesario para atenderte.\n' +
    '- Puedes ejercer tus derechos de acceso, rectificación y eliminación escribiendo a ' +
    `${CORREO_SOPORTE}.\n\n` +
    'PARA CONTINUAR\n' +
    'Responde a este mismo correo con la palabra: ACEPTO\n\n' +
    'En cuanto recibamos tu aceptación, continuamos con tu solicitud. Si no la recibimos dentro de las ' +
    `próximas ${horas} horas, tu caso será igualmente atendido por un agente de nuestro equipo, que te ` +
    'responderá en un plazo de 48 a 52 horas.'
  );
}

/** Texto que se envía al cliente cuando su solicitud se delega por no aceptar. */
export function textoDelegacionPorNoAceptar() {
  return (
    'Estimado/a usuario/a:\n\n' +
    'No recibimos tu aceptación de la política de tratamiento de datos dentro del plazo, por lo que tu ' +
    'solicitud será atendida directamente por un agente de nuestro equipo.\n\n' +
    'Un agente te responderá por este mismo correo en un plazo de 48 a 52 horas. Si deseas que la ' +
    'atención sea inmediata y automática, puedes responder ACEPTO en cualquier momento.'
  );
}

// ── Alcance 'cliente': aceptación por correo del cliente, con vigencia ──────
export async function tieneConsentimiento(remitente) {
  const email = extraerEmail(remitente);
  if (!email) return false;
  const col = await coleccionConsentimientos();
  const doc = await col.findOne({ _id: email });
  if (!doc) return false;
  return !doc.vigenteHasta || new Date(doc.vigenteHasta) > new Date();
}

export async function registrarConsentimiento(remitente, hiloId) {
  const email = extraerEmail(remitente);
  if (!email) return;
  const col = await coleccionConsentimientos();
  const ahora = new Date();
  const vigenteHasta = new Date(ahora.getTime() + config.consentimiento.vigenciaDias * 86400000);
  await col.updateOne(
    { _id: email },
    { $set: { aceptadoEn: ahora, vigenteHasta, hiloId }, $setOnInsert: { creadoEn: ahora } },
    { upsert: true }
  );
}

// ── Alcance 'correo' (por defecto): aceptación por HILO de correo ───────────
// Se guarda una marca en la propia conversación; así cada solicitud nueva vuelve
// a pedir la aceptación (ideal para pruebas y para exigirla en cada trámite).
export function conversacionTieneConsentimiento(conversacion) {
  return Boolean(conversacion?.consentimientoAceptado);
}

export async function marcarConsentimientoConversacion(hiloId) {
  const col = await coleccionConversaciones();
  await col.updateOne({ _id: hiloId }, { $set: { consentimientoAceptado: true, consentimientoEn: new Date() } });
}

/**
 * Fachada que respeta el alcance configurado. `conversacion` se usa en alcance
 * 'correo'; `remitente` en alcance 'cliente'.
 */
export async function yaConsintio({ conversacion, remitente }) {
  return config.consentimiento.porCorreo
    ? conversacionTieneConsentimiento(conversacion)
    : tieneConsentimiento(remitente);
}

export async function marcarConsentimiento({ hiloId, remitente }) {
  if (config.consentimiento.porCorreo) return marcarConsentimientoConversacion(hiloId);
  return registrarConsentimiento(remitente, hiloId);
}

/**
 * El último mensaje del CLIENTE con mensajeId (el que corresponde responder para
 * que la respuesta caiga en su hilo).
 */
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
 * cliente NO aceptó la política dentro del plazo. Por cada una crea un caso
 * (misma mecánica de viaje de vuelta que un escalamiento normal) y devuelve lo
 * que n8n debe enviar: el correo de delegación al agente y el aviso al cliente.
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
        resumenCorto: 'Cliente no aceptó política — atender solicitud',
        descripcionDetallada:
          'El cliente NO aceptó la política de tratamiento de datos dentro del plazo. Atiende su ' +
          'solicitud original directamente (SLA 48–52 h). Solicitud del cliente:\n\n' + resumenSolicitud(conv),
        datosEstudiante: 'no proporcionado',
        datosInstitucion: 'no proporcionado',
        intentosPrevios: 'Se envió la política de datos y no hubo aceptación en el plazo.',
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
          eventos: { tipo: 'delegado_por_no_aceptar_politica', detalle: { codigo: escalamiento.codigo, horas: limiteHoras }, fecha: new Date() },
        },
      }
    );

    resultados.push({
      hiloId: conv._id,
      // Aviso al cliente (reply en su hilo original).
      mensajeIdCliente: ultimo?.mensajeId || null,
      remitenteCliente: conv.remitente,
      textoRespuesta: conFirmaTexto(avisoCliente),
      textoRespuestaHtml: textoAHtml(avisoCliente),
      // Delegación al agente (mismo formato que la rama "escalar").
      escalamiento,
    });
  }

  return resultados;
}
