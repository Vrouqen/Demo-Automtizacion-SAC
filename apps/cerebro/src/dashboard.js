import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Dashboard de analítica del piloto.
 *
 * Se sirve desde la MISMA Function URL del cerebro (`GET /?vista=dashboard`) y
 * consulta `GET /?reporte=analitica` desde el navegador. Así no hay que montar
 * hosting, dominio ni CORS aparte: una sola Lambda sirve la página y los datos.
 *
 * El HTML vive en `dashboard.html` en vez de en una plantilla dentro de este
 * archivo para no tener que escapar el JavaScript del cliente. Se lee una sola
 * vez por contenedor Lambda: en las invocaciones calientes sale de memoria.
 */
let html = null;

export function paginaDashboard() {
  if (html === null) {
    html = readFileSync(fileURLToPath(new URL('./dashboard.html', import.meta.url)), 'utf8');
  }
  return html;
}
