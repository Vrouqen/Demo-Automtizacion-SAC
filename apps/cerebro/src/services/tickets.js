import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { registrarTicket, obtenerUltimoTicket } from './conversaciones.js';
import { registrarDerivacionTicket } from './escalamientos.js';
import { textoAHtml } from '../utils/correo.js';

const EQUIPOS = {
  cuentas: 'Cuentas',
  servicio_digital: 'Servicio Digital',
};

const TIPOS = {
  reset_password: 'Reseteo de contraseña',
  incidencia_plataforma: 'Incidencia de plataforma',
};

/**
 * A quién se le avisa de un ticket nuevo mientras Jira está en standby.
 * Cada equipo puede tener su propio buzón; si no está configurado, cae en la
 * lista de agentes digitales para que el ticket NUNCA quede sin destinatario.
 */
function destinatarioEquipo(equipo) {
  const propio = equipo === 'cuentas' ? config.equipos.cuentas : config.equipos.servicioDigital;
  if (propio) return propio;
  return config.agentes.correos.join(',');
}

/**
 * Correo de aviso del ticket. Es el equivalente al correo de delegación de un
 * escalamiento: el equipo que lo atiende NO ve el hilo del cliente, así que
 * todo lo necesario viaja aquí.
 */
function armarCorreoTicket({ ticket, hiloId, asuntoOriginal, usuarioAfectado, institucion, plataforma }) {
  const para = destinatarioEquipo(ticket.equipo);
  const tipoLegible = TIPOS[ticket.tipo] || ticket.tipo;
  const resumen = [usuarioAfectado, institucion].filter(Boolean).join(' — ').slice(0, 70);

  const cuerpo = [
    'Hola,',
    'El asistente automático de soporte registró este ticket y te lo asigna.',
    `DATOS DEL TICKET\nCódigo: ${ticket.jiraKey}\nTipo: ${tipoLegible}\nEquipo: ${EQUIPOS[ticket.equipo] || ticket.equipo}\nSolicitante: ${ticket.reportadoPor}`,
    `QUÉ SE NECESITA\n${ticket.descripcion}`,
    plataforma ? `PLATAFORMA\n${plataforma}` : null,
    ticket.enlazadoA ? `TICKET RELACIONADO\nEste ticket viene del mismo hilo que ${ticket.enlazadoA}.` : null,
    'CÓMO RESPONDER\nAtiende el ticket y responde directamente al solicitante en su hilo de correo original. Este aviso es informativo: responder a ESTE correo no llega al cliente.',
    `Referencia interna del hilo: ${hiloId}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    para,
    asunto: `[${ticket.jiraKey}] ${tipoLegible}${resumen ? ` — ${resumen}` : ''}`,
    cuerpo,
    // Correo interno: sin firma comercial.
    cuerpoHtml: textoAHtml(cuerpo, { firma: false }),
    asuntoOriginal: asuntoOriginal || '',
  };
}

/**
 * Crea un ticket para el hilo de correo. Si ya existe un ticket previo en el
 * mismo hilo (ej. un reset de contraseña ya resuelto y ahora el usuario
 * reporta otra incidencia distinta), el nuevo ticket NO reutiliza ni reabre
 * el anterior — se crea uno nuevo y se enlaza a él (`enlazadoA`). Esto evita
 * mezclar categorías/equipos distintos en un mismo ticket y mantiene las
 * métricas de tiempo de resolución de Jira correctas.
 *
 * Jira real está en STANDBY (JIRA_HABILITADO=false por defecto): el ticket se
 * registra en Mongo como "pendiente_jira" Y se devuelve `correoTicket` para que
 * n8n se lo envíe al equipo responsable. Sin ese correo el ticket no existiría
 * para nadie: al cliente se le prometía que "el equipo de Cuentas lo atenderá"
 * mientras el ticket se quedaba dormido en Mongo.
 */
export async function crearTicket({
  hiloId,
  mensajeId,
  tipo,
  equipo,
  descripcion,
  adjuntos = [],
  reportadoPor,
  asuntoOriginal,
  usuarioAfectado,
  institucion,
  plataforma,
}) {
  const ticketAnterior = await obtenerUltimoTicket(hiloId);

  if (config.jira.habilitado) {
    // TODO (cuando Jira salga de standby): reemplazar por las llamadas reales:
    //   POST {jira.baseUrl}/rest/api/3/issue                          -> crear el ticket
    //   POST {jira.baseUrl}/rest/api/3/issueLink                      -> enlazar con
    //        ticketAnterior.jiraKey (type: "Relates") si ticketAnterior existe
    // Autenticación: Basic Auth con jira.email + jira.apiToken.
    // Al conectarlo, `correoTicket` deja de hacer falta: el aviso lo manda Jira.
    throw new Error(
      'JIRA_HABILITADO=true pero la integración real con Jira aún no está implementada (en standby).'
    );
  }

  const ticket = {
    jiraKey: `PENDIENTE-${randomUUID().slice(0, 8).toUpperCase()}`,
    tipo, // 'reset_password' | 'incidencia_plataforma'
    equipo, // 'cuentas' | 'servicio_digital'
    descripcion,
    adjuntos,
    reportadoPor,
    estado: 'pendiente_jira',
    enlazadoA: ticketAnterior?.jiraKey || null,
  };

  await registrarTicket(hiloId, ticket);

  const correoTicket = armarCorreoTicket({
    ticket,
    hiloId,
    asuntoOriginal,
    usuarioAfectado,
    institucion,
    plataforma,
  });

  // Viaje de vuelta: cuando el equipo responda al aviso, su respuesta llega sola
  // al cliente (igual que en un caso). Sin esto, la respuesta del equipo se
  // perdía o el sistema la malinterpretaba como una consulta nueva.
  await registrarDerivacionTicket({
    jiraKey: ticket.jiraKey,
    hiloId,
    mensajeId,
    remitente: reportadoPor,
    asuntoOriginal,
    agenteEmail: correoTicket.para,
    tipoTicket: tipo,
    equipo,
  });

  return { ...ticket, correoTicket };
}
