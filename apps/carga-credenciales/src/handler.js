import { validarConfig } from './config.js';
import { parsearExcelCredenciales } from './excel/parseExcel.js';
import { coleccionColegios } from './db/mongo.js';
import { normalizar } from './utils/similitud.js';

function respuestaJson(statusCode, cuerpo) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  };
}

/**
 * Lambda expuesta vía Function URL.
 *
 * POST body (JSON):
 *   { idColegio, codigoColegio, nombreColegio, provincia?, nombreArchivo, archivoBase64 }
 * archivoBase64 = contenido del .xlsx codificado en base64 (ver docs/SETUP_AWS.md
 * para el ejemplo de curl).
 *
 * GET ?listar=1 -> lista los colegios cargados (sin credenciales).
 */
export const handler = async (event) => {
  try {
    validarConfig();

    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

    if (metodo === 'GET' && query.listar) {
      const col = await coleccionColegios();
      const docs = await col.find({}, { projection: { nombre: 1, codigo: 1, provincia: 1 } }).toArray();
      return respuestaJson(
        200,
        docs.map((d) => ({ id: d._id, codigo: d.codigo, nombre: d.nombre, provincia: d.provincia }))
      );
    }

    if (!event.body) {
      return respuestaJson(400, { error: 'Falta el body de la solicitud' });
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const body = JSON.parse(raw);

    const { idColegio, codigoColegio, nombreColegio, provincia, archivoBase64, nombreArchivo } = body;
    const faltantes = ['idColegio', 'codigoColegio', 'nombreColegio', 'archivoBase64'].filter(
      (campo) => !body[campo]
    );
    if (faltantes.length > 0) {
      return respuestaJson(400, { error: `Faltan campos obligatorios: ${faltantes.join(', ')}` });
    }
    if (nombreArchivo && !/\.(xlsx|xlsm|xltx|xltm)$/i.test(nombreArchivo)) {
      return respuestaJson(400, { error: 'El archivo debe ser Excel (.xlsx)' });
    }

    const buffer = Buffer.from(archivoBase64, 'base64');
    const datos = parsearExcelCredenciales(buffer);

    const col = await coleccionColegios();
    const resultado = await col.updateOne(
      { _id: idColegio },
      {
        $set: {
          codigo: codigoColegio,
          nombre: nombreColegio,
          nombreNormalizado: normalizar(nombreColegio),
          provincia: provincia || 'n/a',
          provinciaNormalizada: normalizar(provincia || 'n/a'),
          docentes: datos.docentes,
          estudiantes: datos.estudiantes,
          hojasProcesadas: datos.hojasProcesadas,
          actualizadoEn: new Date(),
        },
      },
      { upsert: true }
    );

    return respuestaJson(200, {
      id: idColegio,
      codigo: codigoColegio,
      nombre: nombreColegio,
      provincia: provincia || 'n/a',
      hojasProcesadas: datos.hojasProcesadas,
      docentes: datos.docentes.length,
      estudiantes: datos.estudiantes.length,
      creado: resultado.upsertedId !== null,
    });
  } catch (err) {
    console.error(err);
    return respuestaJson(err.statusCode || 500, { error: err.message });
  }
};
