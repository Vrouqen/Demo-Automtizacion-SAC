import { config, validarConfig } from './config.js';
import { parsearExcelCredenciales } from './excel/parseExcel.js';
import { coleccionColegios } from './db/mongo.js';
import { normalizar } from './utils/similitud.js';
import { cifrar } from './utils/cifrado.js';

function respuestaJson(statusCode, cuerpo) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  };
}

function contarActivos(estudiantes = []) {
  return estudiantes.filter((e) => e.activo).length;
}

/**
 * Lambda expuesta vía Function URL. Permite cargar credenciales de forma
 * progresiva: cada POST reemplaza solo las credenciales de LA PLATAFORMA
 * indicada para ese colegio; las de la otra plataforma se conservan.
 *
 * POST body (JSON):
 *   {
 *     idColegio,        // Id del colegio (id de Pegasus)
 *     codigoColegio,    // Código del colegio
 *     region,           // Región (Costa / Sierra / Oriente / Insular)
 *     ciudad,           // Ciudad (Provincia) — se acepta también "provincia"
 *     canton,           // Cantón
 *     nombreColegio,    // Nombre del colegio (del avance)
 *     plataforma,       // OBLIGATORIO: solo "compartir" o "creo"
 *     nombreArchivo, archivoBase64
 *   }
 *
 * Login, contraseña y PIN se cifran (AES-256-GCM) antes de guardarse en Mongo.
 * Un estudiante queda marcado como "activo" si su fila trae PIN asociado.
 *
 * GET ?listar=1 -> lista los colegios cargados (sin credenciales), con conteo
 * de estudiantes activos y plataformas cargadas.
 */
export const handler = async (event) => {
  try {
    validarConfig();

    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

    if (metodo === 'GET' && query.listar) {
      const col = await coleccionColegios();
      const docs = await col
        .find({}, { projection: { 'estudiantes.login': 0, 'estudiantes.contrasena': 0, 'estudiantes.pin': 0, 'docentes.login': 0, 'docentes.contrasena': 0, 'docentes.pin': 0 } })
        .toArray();
      return respuestaJson(
        200,
        docs.map((d) => ({
          id: d._id,
          codigo: d.codigo,
          nombre: d.nombre,
          region: d.region,
          ciudad: d.ciudad,
          canton: d.canton,
          plataformas: [...new Set([...(d.estudiantes || []), ...(d.docentes || [])].map((r) => r.plataforma).filter(Boolean))],
          estudiantes: (d.estudiantes || []).length,
          estudiantesActivos: contarActivos(d.estudiantes),
          docentes: (d.docentes || []).length,
        }))
      );
    }

    if (!event.body) {
      return respuestaJson(400, { error: 'Falta el body de la solicitud' });
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const body = JSON.parse(raw);

    const { idColegio, codigoColegio, nombreColegio, region, canton, archivoBase64, nombreArchivo } = body;
    const ciudad = body.ciudad || body.provincia; // "Ciudad (Provincia)": se aceptan ambos nombres

    const faltantes = ['idColegio', 'codigoColegio', 'nombreColegio', 'plataforma', 'archivoBase64'].filter(
      (campo) => !body[campo]
    );
    if (faltantes.length > 0) {
      return respuestaJson(400, { error: `Faltan campos obligatorios: ${faltantes.join(', ')}` });
    }

    const plataforma = normalizar(body.plataforma);
    if (!config.plataformasPermitidas.includes(plataforma)) {
      return respuestaJson(400, {
        error: `Plataforma "${body.plataforma}" no permitida. Solo se cargan credenciales de: ${config.plataformasPermitidas.join(', ')}`,
      });
    }

    if (nombreArchivo && !/\.(xlsx|xlsm|xltx|xltm)$/i.test(nombreArchivo)) {
      return respuestaJson(400, { error: 'El archivo debe ser Excel (.xlsx)' });
    }

    const buffer = Buffer.from(archivoBase64, 'base64');
    const datos = parsearExcelCredenciales(buffer);

    // Marca plataforma + activo (activo = tiene PIN asociado) y cifra las
    // credenciales antes de tocar la base.
    const preparar = (registros) =>
      registros.map((r) => ({
        ...r,
        plataforma,
        activo: Boolean(r.pin && String(r.pin).trim() !== ''),
        login: cifrar(r.login, config.cifrado.clave),
        contrasena: cifrar(r.contrasena, config.cifrado.clave),
        pin: cifrar(r.pin, config.cifrado.clave),
      }));

    const nuevosDocentes = preparar(datos.docentes);
    const nuevosEstudiantes = preparar(datos.estudiantes);

    const col = await coleccionColegios();

    // Carga progresiva: conserva los registros de las OTRAS plataformas y
    // reemplaza solo los de la plataforma de esta carga.
    const existente = await col.findOne({ _id: idColegio });
    const conservarOtras = (lista = []) => lista.filter((r) => r.plataforma && r.plataforma !== plataforma);

    const docentes = [...conservarOtras(existente?.docentes), ...nuevosDocentes];
    const estudiantes = [...conservarOtras(existente?.estudiantes), ...nuevosEstudiantes];

    const resultado = await col.updateOne(
      { _id: idColegio },
      {
        $set: {
          codigo: codigoColegio,
          nombre: nombreColegio,
          nombreNormalizado: normalizar(nombreColegio),
          region: region || 'n/a',
          regionNormalizada: normalizar(region || 'n/a'),
          ciudad: ciudad || 'n/a',
          ciudadNormalizada: normalizar(ciudad || 'n/a'),
          // compat: código previo usaba "provincia" — se mantiene como espejo de ciudad
          provincia: ciudad || 'n/a',
          provinciaNormalizada: normalizar(ciudad || 'n/a'),
          canton: canton || 'n/a',
          cantonNormalizado: normalizar(canton || 'n/a'),
          docentes,
          estudiantes,
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
      region: region || 'n/a',
      ciudad: ciudad || 'n/a',
      canton: canton || 'n/a',
      plataforma,
      hojasProcesadas: datos.hojasProcesadas,
      docentesCargados: nuevosDocentes.length,
      estudiantesCargados: nuevosEstudiantes.length,
      estudiantesActivos: contarActivos(nuevosEstudiantes),
      totalDocentesColegio: docentes.length,
      totalEstudiantesColegio: estudiantes.length,
      creado: resultado.upsertedId !== null,
    });
  } catch (err) {
    console.error(err);
    return respuestaJson(err.statusCode || 500, { error: err.message });
  }
};
