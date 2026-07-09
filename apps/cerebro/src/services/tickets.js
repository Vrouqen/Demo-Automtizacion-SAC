import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { registrarTicket, obtenerUltimoTicket } from './conversaciones.js';

/**
 * Crea un ticket para el hilo de correo. Si ya existe un ticket previo en el
 * mismo hilo (ej. un reset de contraseña ya resuelto y ahora el usuario
 * reporta otra incidencia distinta), el nuevo ticket NO reutiliza ni reabre
 * el anterior — se crea uno nuevo y se enlaza a él (`enlazadoA`). Esto evita
 * mezclar categorías/equipos distintos en un mismo ticket y mantiene las
 * métricas de tiempo de resolución de Jira correctas.
 *
 * Jira real está en STANDBY (JIRA_HABILITADO=false por defecto): el ticket
 * se registra en Mongo como "pendiente_jira" con toda la info lista para
 * cuando se conecte la integración real.
 */
export async function crearTicket({ hiloId, tipo, equipo, descripcion, adjuntos = [], reportadoPor }) {
  const ticketAnterior = await obtenerUltimoTicket(hiloId);

  let ticket;
  if (config.jira.habilitado) {
    // TODO (cuando Jira salga de standby): reemplazar por las llamadas reales:
    //   POST {jira.baseUrl}/rest/api/3/issue                          -> crear el ticket
    //   POST {jira.baseUrl}/rest/api/3/issueLink                      -> enlazar con
    //        ticketAnterior.jiraKey (type: "Relates") si ticketAnterior existe
    // Autenticación: Basic Auth con jira.email + jira.apiToken.
    throw new Error(
      'JIRA_HABILITADO=true pero la integración real con Jira aún no está implementada (en standby).'
    );
  }

  ticket = {
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
  return ticket;
}
