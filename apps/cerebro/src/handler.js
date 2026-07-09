import { validarConfig } from './config.js';
import { procesarCorreo } from './llm/agente.js';
import { obtenerAnalitica } from './services/conversaciones.js';

function respuestaJson(statusCode, cuerpo) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  };
}

/**
 * Lambda expuesta vía Function URL. n8n llama a este endpoint por cada
 * correo entrante ya parseado (POST), o para consultar la analítica
 * agregada (GET ?reporte=analitica).
 */
export const handler = async (event) => {
  try {
    validarConfig();

    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

    if (metodo === 'GET' && query.reporte === 'analitica') {
      const resumen = await obtenerAnalitica({ desde: query.desde, hasta: query.hasta });
      return respuestaJson(200, resumen);
    }

    if (!event.body) {
      return respuestaJson(400, { error: 'Falta el body de la solicitud' });
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const body = JSON.parse(raw);

    const faltantes = ['hiloId', 'remitente', 'cuerpo'].filter((c) => !body[c]);
    if (faltantes.length > 0) {
      return respuestaJson(400, { error: `Faltan campos: ${faltantes.join(', ')}` });
    }

    const resultado = await procesarCorreo(body);
    return respuestaJson(200, resultado);
  } catch (err) {
    console.error(err);
    return respuestaJson(500, { error: err.message });
  }
};
