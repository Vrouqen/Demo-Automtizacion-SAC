import { coleccionConversaciones } from '../db/mongo.js';
import { registrarEvento } from './conversaciones.js';
import { crearEscalamiento } from './escalamientos.js';
import { conFirmaTexto } from '../utils/firma.js';
import { textoAHtml } from '../utils/correo.js';

/**
 * Cola de correos pendientes por falta de cuota de IA.
 *
 * El problema que resuelve: cuando el proveedor de IA agota su cuota, el correo
 * no se puede responder en ese momento. n8n reintenta unas pocas veces en
 * segundos, pero si lo agotado es la cuota DIARIA esos reintentos también fallan
 * — y el disparador de Outlook no vuelve a entregar un correo ya entregado, así
 * que el mensaje quedaba sin responder para siempre.
 *
 * La cola no necesita infraestructura nueva: el mensaje del usuario ya se guarda
 * en su conversación ANTES de llamar al modelo, así que lo pendiente es un
 * estado en Mongo, no un mensaje en tránsito. Aquí solo se marca, se ordena y se
 * drena.
 *
 * Reglas de la cola:
 *  - FIFO: primero el que lleva más esperando; nadie se queda al fondo.
 *  - Espera creciente entre intentos, y más larga si lo agotado fue la cuota
 *    (que suele ser diaria) que si fue un error puntual del proveedor.
 *  - Salida garantizada: pasado el límite de horas, el correo deja de esperar a
 *    la IA y se delega a una persona. Una cola sin salida es una cola donde los
 *    correos se pudren en silencio.
 */

/** Espera entre intentos, en minutos, según cuántos lleve. */
const ESPERA_CUOTA = [30, 60, 120, 240, 360]; // la cuota diaria tarda horas en volver
const ESPERA_ERROR = [5, 15, 30, 60, 120]; // un fallo puntual del proveedor se recupera antes

/** Tras estas horas esperando, el correo se deriva a una persona. */
const HORAS_ANTES_DE_DELEGAR = 12;

/** Cuántos correos se procesan por corrida, por defecto. */
const LOTE = 5;

/**
 * Minutos de espera antes del siguiente intento. Exportada para poder probarla:
 * es la única parte de este servicio que no depende de Mongo, y es justo donde
 * un error se nota tarde (reintentos demasiado seguidos queman la cuota que
 * acaba de reponerse; demasiado espaciados hacen esperar al usuario de más).
 */
export function esperaMinutos(motivo, intentos) {
  const escala = motivo === 'cuota_agotada' ? ESPERA_CUOTA : ESPERA_ERROR;
  const indice = Math.min(Math.max(intentos, 1), escala.length) - 1;
  return escala[indice];
}

/**
 * Marca la conversación como pendiente de reintento. Se llama cada vez que el
 * modelo no pudo responder; los intentos se acumulan para espaciar la espera.
 *
 * Sin `mensajeId` no se encola: sin él no se podría responder en el hilo del
 * usuario aunque el reintento funcionara.
 */
export async function encolar({ hiloId, mensajeId, motivo }) {
  if (!mensajeId) return { encolado: false, razon: 'sin_mensaje_id' };

  const col = await coleccionConversaciones();
  const conv = await col.findOne({ _id: hiloId }, { projection: { pendienteIA: 1 } });

  const intentos = (conv?.pendienteIA?.intentos || 0) + 1;
  const desde = conv?.pendienteIA?.desde || new Date();
  const proximoIntento = new Date(Date.now() + esperaMinutos(motivo, intentos) * 60000);

  await col.updateOne(
    { _id: hiloId },
    { $set: { pendienteIA: { desde, mensajeId, motivo, intentos, ultimoIntento: new Date(), proximoIntento } } }
  );

  return { encolado: true, intentos, proximoIntento };
}

/** El correo ya se respondió: sale de la cola. */
export async function desencolar(hiloId) {
  const col = await coleccionConversaciones();
  await col.updateOne({ _id: hiloId }, { $unset: { pendienteIA: '' } });
}

/** Cuántos correos esperan y desde cuándo. Para el dashboard y las alertas. */
export async function estadoCola() {
  const col = await coleccionConversaciones();
  const [resumen] = await col
    .aggregate([
      { $match: { pendienteIA: { $exists: true } } },
      { $group: { _id: null, total: { $sum: 1 }, masAntiguo: { $min: '$pendienteIA.desde' } } },
    ])
    .toArray();

  return {
    pendientes: resumen?.total || 0,
    esperandoDesde: resumen?.masAntiguo || null,
    horasDelMasAntiguo: resumen?.masAntiguo
      ? +((Date.now() - new Date(resumen.masAntiguo).getTime()) / 3600000).toFixed(1)
      : 0,
  };
}

/** Texto que recibe el cliente cuando su correo lleva demasiado esperando. */
function textoDelegacionPorEspera() {
  return (
    'Estimado/a usuario/a:\n\n' +
    'Su solicitud está tardando más de lo habitual en procesarse, así que la hemos asignado a un ' +
    'agente de nuestro equipo para que la atienda directamente.\n\n' +
    'Le responderemos por este mismo correo. Disculpe la demora.'
  );
}

/** Resumen del hilo, para que el agente pueda atenderlo sin más contexto. */
function resumenSolicitud(conv) {
  return (
    (conv.mensajes || [])
      .filter((m) => m.rol === 'usuario')
      .map((m) => String(m.cuerpo || '').trim())
      .filter(Boolean)
      .join('\n---\n')
      .slice(0, 1500) || '(sin contenido)'
  );
}

/**
 * Saca de la cola los correos que llevan demasiado tiempo esperando y los
 * delega a una persona. Devuelve lo que n8n debe enviar por cada uno.
 */
async function delegarLosQueYaEsperaronDemasiado(col) {
  const limite = new Date(Date.now() - HORAS_ANTES_DE_DELEGAR * 3600 * 1000);
  const vencidos = await col.find({ 'pendienteIA.desde': { $lt: limite } }).toArray();

  const aviso = textoDelegacionPorEspera();
  const delegados = [];

  for (const conv of vencidos) {
    let escalamiento;
    try {
      escalamiento = await crearEscalamiento({
        hiloId: conv._id,
        mensajeId: conv.pendienteIA.mensajeId,
        remitente: conv.remitente,
        asunto: conv.asunto,
        motivo: 'otro',
        resumenCorto: 'Correo sin procesar por falta de cuota de IA',
        descripcionDetallada:
          `Este correo no pudo procesarse automáticamente durante ${HORAS_ANTES_DE_DELEGAR} horas ` +
          `(motivo: ${conv.pendienteIA.motivo}, ${conv.pendienteIA.intentos} intentos). Atiéndelo ` +
          'directamente. Solicitud del cliente:\n\n' +
          resumenSolicitud(conv),
        datosEstudiante: 'no proporcionado',
        datosInstitucion: 'no proporcionado',
        intentosPrevios: 'El asistente no llegó a procesarlo: el servicio de IA no tenía cuota disponible.',
      });
    } catch (err) {
      console.error('[cola] no se pudo delegar el correo en espera:', err.message);
      continue; // sin destinatario no se delega; se reintenta en la próxima corrida
    }

    await col.updateOne(
      { _id: conv._id },
      {
        $unset: { pendienteIA: '' },
        $set: { estado: 'esperando_agente', actualizadoEn: new Date() },
        $push: {
          mensajes: { rol: 'asistente', cuerpo: aviso, fecha: new Date() },
          eventos: {
            tipo: 'delegado_por_espera_en_cola',
            detalle: { codigo: escalamiento.codigo, motivo: conv.pendienteIA.motivo },
            fecha: new Date(),
          },
        },
      }
    );

    delegados.push({
      hiloId: conv._id,
      mensajeIdCliente: conv.pendienteIA.mensajeId,
      remitenteCliente: conv.remitente,
      textoRespuesta: conFirmaTexto(aviso),
      textoRespuestaHtml: textoAHtml(aviso),
      escalamiento,
    });
  }

  return delegados;
}

/**
 * Drena la cola: reprocesa los correos cuyo turno ya llegó y devuelve las
 * respuestas listas para que n8n las envíe.
 *
 * `procesar` se recibe por parámetro (es `procesarCorreo`) para no crear un
 * ciclo de imports entre este servicio y el agente.
 *
 * Se procesa un lote pequeño por corrida a propósito: si se intentara vaciar la
 * cola entera de golpe con la cuota recién repuesta, se volvería a agotar en la
 * primera tanda y todos los demás quedarían igual de atascados.
 */
export async function drenarCola({ limite = LOTE, procesar }) {
  const col = await coleccionConversaciones();

  // Primero los que ya no tiene sentido seguir reintentando.
  const delegados = await delegarLosQueYaEsperaronDemasiado(col);

  const ahora = new Date();
  const pendientes = await col
    .find({ pendienteIA: { $exists: true }, 'pendienteIA.proximoIntento': { $lte: ahora } })
    .sort({ 'pendienteIA.desde': 1 }) // FIFO: el que más lleva esperando, primero
    .limit(Math.min(Math.max(Number(limite) || LOTE, 1), 20))
    .toArray();

  const respuestas = [];
  let sinCuota = false;

  for (const conv of pendientes) {
    // Si la cuota sigue agotada, el resto del lote fallaría igual: se corta y se
    // deja para la próxima corrida en vez de quemar intentos y registros.
    if (sinCuota) break;

    const mensaje = (conv.mensajes || [])
      .filter((m) => m.rol === 'usuario' && m.mensajeId === conv.pendienteIA.mensajeId)
      .pop();

    if (!mensaje) {
      // El mensaje ya no está (hilo depurado o editado): sacarlo de la cola
      // evita que se reintente eternamente algo que no se puede reconstruir.
      await col.updateOne({ _id: conv._id }, { $unset: { pendienteIA: '' } });
      continue;
    }

    const resultado = await procesar({
      hiloId: conv._id,
      mensajeId: mensaje.mensajeId,
      remitente: conv.remitente,
      cuentaSoporte: conv.cuentaSoporte,
      asunto: conv.asunto,
      cuerpo: mensaje.cuerpo,
      adjuntos: mensaje.adjuntos || [],
    });

    if (resultado.accion === 'error_temporal') {
      await encolar({ hiloId: conv._id, mensajeId: mensaje.mensajeId, motivo: resultado.motivo });
      sinCuota = resultado.motivo === 'cuota_agotada';
      continue;
    }

    await desencolar(conv._id);
    await registrarEvento(conv._id, {
      tipo: 'reprocesado_desde_cola',
      detalle: { intentos: conv.pendienteIA.intentos, motivo: conv.pendienteIA.motivo, accion: resultado.accion },
    });

    // Solo se devuelven las acciones que n8n sabe enviar. Un 'ninguna' (el
    // correo ya se respondió por otra vía mientras esperaba) sale de la cola
    // igual, pero no tiene sentido pasárselo al flujo: ninguna rama lo recoge.
    if (['responder', 'escalar', 'responder_y_crear_ticket'].includes(resultado.accion)) {
      respuestas.push(resultado);
    }
  }

  const cola = await estadoCola();
  return { respuestas, delegados, cola, cortadoPorCuota: sinCuota };
}
