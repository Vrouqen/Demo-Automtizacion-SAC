/**
 * Levanta la Lambda de credenciales como un servidor HTTP local.
 *
 * Sirve para probar la interfaz de TEE sin desplegar y sin TLS de por medio:
 * traduce una petición de Node al evento de Function URL que espera el handler
 * y devuelve su respuesta tal cual.
 *
 * Uso (PowerShell), apuntando al Mongo del contenedor de pruebas:
 *   $env:MONGODB_URI = "mongodb://localhost:27018/sac"
 *   node scripts/servidor-local.mjs
 *
 * Sin esa variable usa la del .env, que apunta a PRODUCCIÓN. Es deliberado que
 * haya que escribirla a mano: así nadie borra un padrón real creyendo que está
 * en local.
 */
import { createServer } from 'node:http';
import 'dotenv/config';
import { config } from '../src/config.js';
import { handler } from '../src/handler.js';

const PUERTO = Number(process.env.PUERTO_LOCAL || 3001);

// Aviso visible al arrancar: la diferencia entre local y producción es una sola
// variable de entorno, y equivocarse es caro.
const destino = String(config.mongo.uri || '').replace(/\/\/[^@]*@/, '//<credenciales>@');
const esLocal = /localhost|127\.0\.0\.1/.test(destino);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PUERTO}`);
  const trozos = [];
  for await (const t of req) trozos.push(t);
  const cuerpo = Buffer.concat(trozos);

  const evento = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: req.headers,
    requestContext: { http: { method: req.method, path: url.pathname } },
    body: cuerpo.length ? cuerpo.toString('base64') : undefined,
    isBase64Encoded: cuerpo.length > 0,
  };

  try {
    const r = await handler(evento);
    res.writeHead(r.statusCode || 200, r.headers || {});
    res.end(r.body ? Buffer.from(r.body, r.isBase64Encoded ? 'base64' : 'utf8') : '');
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PUERTO, () => {
  console.log(`Lambda de credenciales en http://localhost:${PUERTO}`);
  console.log(`Mongo: ${destino}`);
  if (!esLocal) {
    console.log('\n  *** ATENCIÓN: esto NO es una base local. Editar o borrar aquí afecta datos reales. ***\n');
  }
});
