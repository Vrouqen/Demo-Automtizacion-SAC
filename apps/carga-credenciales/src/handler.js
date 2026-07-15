import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config, validarConfig } from './config.js';
import { parsearExcelCredenciales } from './excel/parseExcel.js';
import { coleccionColegios } from './db/mongo.js';
import { normalizar } from './utils/similitud.js';
import { cifrar, descifrar } from './utils/cifrado.js';
import { crearToken, verificarToken, tokenDeEvento, igualSeguro } from './utils/sesion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paginaHtml = readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

function respuestaJson(statusCode, cuerpo) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  };
}

/**
 * Lambda expuesta vía Function URL. Carga credenciales de ESTUDIANTES de forma
 * progresiva: cada POST toca solo los registros de la plataforma y el periodo
 * indicados, y dentro de ellos fusiona por persona (actualiza a quien ya existía
 * y agrega a quien no), sin borrar a los que no vengan en el archivo.
 *
 * Solo estudiantes: si el Excel trae una pestaña "Docentes" se ignora — el
 * programa ya no gestiona credenciales de docentes.
 *
 * POST body (JSON):
 *   {
 *     idColegio,        // Id del colegio (id de Pegasus)
 *     codigoColegio,    // Código del colegio
 *     region,           // Región (Costa / Sierra)
 *     ciudad,           // Ciudad (Provincia) — se acepta también "provincia"
 *     canton,           // Cantón
 *     nombreColegio,    // Nombre del colegio (del avance)
 *     plataforma,       // OBLIGATORIO: solo "compartir" o "creo"
 *     periodo,          // OBLIGATORIO: periodo escolar, formato "2026-2027"
 *     nombreArchivo, archivoBase64
 *   }
 *
 * Login y contraseña se cifran (AES-256-GCM) antes de guardarse en Mongo.
 *
 * Esta app hace UNA sola cosa: subir credenciales a la base. No calcula ni
 * reporta estados (p. ej. quién está activo) — de eso se encarga apps/cerebro.
 *
 * POST ?login=1 -> valida usuario/clave y entrega el token de sesión.
 * GET / (sin query params) -> sirve el formulario web de carga.
 * GET ?listar=1 -> lista los colegios cargados (sin credenciales), con sus
 * plataformas, periodos y cantidad de estudiantes.
 */
export const handler = async (event) => {
  try {
    validarConfig();

    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

    if (metodo === 'GET' && !query.listar) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: paginaHtml,
      };
    }

    // Login: entrega un token firmado que las peticiones de datos deben traer.
    if (metodo === 'POST' && query.login) {
      const credenciales = JSON.parse(
        event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}'
      );
      const usuarioOk = igualSeguro(credenciales.usuario, config.acceso.usuario);
      const claveOk = igualSeguro(credenciales.clave, config.acceso.clave);
      if (!usuarioOk || !claveOk) {
        return respuestaJson(401, { error: 'Usuario o contraseña incorrectos' });
      }
      return respuestaJson(200, {
        token: crearToken(config.acceso.usuario, config.cifrado.clave),
        usuario: config.acceso.usuario,
      });
    }

    // A partir de aquí todo expone o modifica datos de colegios: exige sesión.
    if (!verificarToken(tokenDeEvento(event), config.cifrado.clave)) {
      return respuestaJson(401, { error: 'Sesión inválida o expirada' });
    }

    if (metodo === 'GET' && query.listar) {
      const col = await coleccionColegios();
      // Solo lo necesario para el listado: nunca las credenciales, y tampoco el
      // padrón de docentes (el programa ya no gestiona sus credenciales).
      const docs = await col
        .find(
          {},
          {
            projection: {
              nombre: 1, codigo: 1, region: 1, ciudad: 1, canton: 1,
              'estudiantes.plataforma': 1, 'estudiantes.periodo': 1,
            },
          }
        )
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
          plataformas: [...new Set((d.estudiantes || []).map((r) => r.plataforma).filter(Boolean))],
          periodos: [...new Set((d.estudiantes || []).map((r) => r.periodo).filter(Boolean))].sort(),
          estudiantes: (d.estudiantes || []).length,
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

    const faltantes = ['idColegio', 'codigoColegio', 'nombreColegio', 'plataforma', 'periodo', 'archivoBase64'].filter(
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

    const periodo = String(body.periodo).trim();
    if (!/^\d{4}-\d{4}$/.test(periodo)) {
      return respuestaJson(400, { error: `Periodo "${body.periodo}" inválido. Formato esperado: 2026-2027` });
    }

    if (nombreArchivo && !/\.(xlsx|xlsm|xltx|xltm)$/i.test(nombreArchivo)) {
      return respuestaJson(400, { error: 'El archivo debe ser Excel (.xlsx)' });
    }

    const buffer = Buffer.from(archivoBase64, 'base64');
    const datos = parsearExcelCredenciales(buffer);

    // Marca plataforma + periodo y cifra las credenciales antes de tocar la
    // base. Esta app solo sube credenciales: no calcula ni guarda estados —
    // quién está activo lo deduce apps/cerebro al consultar.
    const preparar = (r) => ({
      ...r,
      plataforma,
      periodo,
      login: cifrar(r.login, config.cifrado.clave),
      contrasena: cifrar(r.contrasena, config.cifrado.clave),
    });

    const col = await coleccionColegios();
    const existente = await col.findOne({ _id: idColegio });

    // Identidad de una persona dentro de un colegio: su login de plataforma y,
    // si la fila no lo trae, su nombre completo. Ojo: cifrar() usa un IV
    // aleatorio, así que el mismo login da un cifrado distinto cada vez —
    // comparar los valores cifrados NO sirve; hay que descifrar los guardados.
    const idDeFila = (r) => normalizar(r.login) || 'nombre:' + normalizar(r.nombreCompleto);
    const idDeGuardado = (r) =>
      normalizar(descifrar(r.login, config.cifrado.clave)) || 'nombre:' + normalizar(r.nombreCompleto);
    const mismoValor = (a, b) => (a ?? '') === (b ?? '');

    // Fusiona el Excel con lo ya guardado de esta plataforma+periodo: a quien ya
    // existía se le actualizan sus credenciales (detectando si de verdad
    // cambiaron), y a quien no, se le agrega. No se borra a nadie que no venga
    // en el archivo, para que una carga parcial no elimine al resto del padrón.
    const fusionar = (guardados, filas) => {
      const salida = guardados.slice();
      const indice = new Map();
      salida.forEach((r, i) => indice.set(idDeGuardado(r), i));

      const resumen = { filas: filas.length, nuevos: 0, actualizados: 0, sinCambios: 0 };
      for (const fila of filas) {
        const id = idDeFila(fila);
        const i = indice.get(id);
        if (i === undefined) {
          indice.set(id, salida.length);
          salida.push(preparar(fila));
          resumen.nuevos++;
          continue;
        }
        const antes = salida[i];
        const cambio = !mismoValor(descifrar(antes.contrasena, config.cifrado.clave), fila.contrasena);
        salida[i] = preparar(fila);
        if (cambio) resumen.actualizados++;
        else resumen.sinCambios++;
      }
      return { registros: salida, resumen };
    };

    // Separa lo que esta carga toca (misma plataforma+periodo) de lo que debe
    // quedar intacto (otras plataformas u otros periodos).
    const esDeEstaCarga = (r) => r.plataforma === plataforma && (!r.periodo || r.periodo === periodo);
    const intactos = (lista = []) => lista.filter((r) => r.plataforma && !esDeEstaCarga(r));
    const deEstaCarga = (lista = []) =>
      lista
        .filter((r) => r.plataforma && esDeEstaCarga(r))
        // Registros previos a que existiera "periodo": se adoptan en el periodo
        // de esta carga en vez de quedar huérfanos sin periodo para siempre.
        .map((r) => (r.periodo ? r : { ...r, periodo }));

    const fusEstudiantes = fusionar(deEstaCarga(existente?.estudiantes), datos.estudiantes);
    const estudiantes = [...intactos(existente?.estudiantes), ...fusEstudiantes.registros];

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
      periodo,
      hojasProcesadas: datos.hojasProcesadas,
      // Pestañas que se ignoraron (típicamente "Docentes"): se informan para que
      // el usuario vea que quedaron fuera a propósito.
      hojasIgnoradas: datos.hojasIgnoradas,
      // "actualizados" = ya existían y su contraseña cambió respecto a lo
      // guardado; "sinCambios" = venían en el Excel idénticos a lo que ya había.
      estudiantes: {
        ...fusEstudiantes.resumen,
        totalPeriodo: fusEstudiantes.registros.length,
        totalColegio: estudiantes.length,
      },
      creado: resultado.upsertedId !== null,
    });
  } catch (err) {
    console.error(err);
    return respuestaJson(err.statusCode || 500, { error: err.message });
  }
};
