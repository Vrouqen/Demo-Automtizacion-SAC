import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';
import path from 'path';
import { config, validarConfig } from './config.js';
import { parsearExcelCredenciales, registroIndividual, registrosDesdeLista } from './excel/parseExcel.js';
import { coleccionColegios, coleccionAdcol } from './db/mongo.js';
import { normalizar } from './utils/similitud.js';
import { buscarPorNombre } from './utils/busquedaNombre.js';
import { ordenarGrados, ordenarParalelos } from './utils/grados.js';
import { cifrar, descifrar } from './utils/cifrado.js';
import { crearToken, verificarToken, tokenDeEvento, igualSeguro } from './utils/sesion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paginaHtml = readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

// La página se comprime y se le calcula el ETag UNA sola vez, al arrancar el
// contenedor: no cambia hasta el siguiente despliegue, así que rehacerlo en cada
// invocación sería gastar CPU (y milisegundos de respuesta) para nada.
const paginaGzip = gzipSync(Buffer.from(paginaHtml, 'utf8'), { level: 9 });
// El comprimido y el plano son representaciones DISTINTAS del mismo recurso, así
// que cada una lleva su propio ETag; si compartieran uno, una caché podría
// responder con la variante equivocada pese al 'vary'.
const paginaEtag = '"' + createHash('sha1').update(paginaHtml).digest('base64').slice(0, 22) + '"';
const paginaEtagGzip = paginaEtag.slice(0, -1) + '-gzip"';

// max-age corto + ETag: dentro de un rato de uso (ir y volver por el menú de
// TEE, que recarga el iframe cada vez) la página sale de la caché sin viajar a
// AWS, y pasado el minuto la revalidación devuelve un 304 sin cuerpo. El precio
// es que tras un despliegue puede verse la versión anterior durante ese minuto.
const CACHE_PAGINA = 'public, max-age=60';

/**
 * Arreglo del documento al que se refiere una consulta: estudiantes o docentes.
 *
 * Ambos se guardan en el mismo documento del colegio, con la misma forma y el
 * mismo cifrado; lo único que cambia es el arreglo. Por defecto, estudiantes:
 * es lo que pedían todas las llamadas antes de que existiera este parámetro, y
 * así una petición vieja sigue significando lo mismo.
 */
function campoDelRol(rol) {
  // Se aceptan singular y plural: quien llame escribirá 'docente' o 'docentes'
  // según de dónde venga, y confundirlos devolvería el arreglo equivocado en
  // silencio, que es la peor forma de fallar aquí.
  return ['docente', 'docentes'].includes(normalizar(rol || '')) ? 'docentes' : 'estudiantes';
}

function respuestaJson(statusCode, cuerpo) {
  return {
    statusCode,
    // Estas respuestas llevan datos de colegios y credenciales descifradas: no
    // deben quedar guardadas en la caché del navegador ni en intermediarios.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(cuerpo),
  };
}

function cabecera(event, nombre) {
  const headers = event.headers || {};
  return headers[nombre] || headers[nombre.toLowerCase()] || '';
}

function aceptaGzip(event) {
  return /\bgzip\b/i.test(cabecera(event, 'accept-encoding'));
}

// Las Function URL no comprimen solas. Si el cliente acepta gzip se comprime
// aquí y se devuelve en base64, que es como Lambda transporta binario. Por
// debajo de 1 KB no compensa: base64 engorda un 33% y lo ahorrado es nada.
const MINIMO_COMPRIMIBLE = 1024;

function comprimir(event, respuesta) {
  const yaComprimida = respuesta.isBase64Encoded || (respuesta.headers || {})['content-encoding'];
  if (yaComprimida || !respuesta.body || !aceptaGzip(event)) return respuesta;

  const bruto = Buffer.from(respuesta.body, 'utf8');
  if (bruto.length < MINIMO_COMPRIMIBLE) return respuesta;

  return {
    ...respuesta,
    headers: { ...respuesta.headers, 'content-encoding': 'gzip' },
    body: gzipSync(bruto).toString('base64'),
    isBase64Encoded: true,
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
export const handler = async (event) => comprimir(event, await responder(event));

const responder = async (event) => {
  try {
    validarConfig();

    const metodo = event.requestContext?.http?.method || 'POST';
    const query = event.queryStringParameters || {};

    // El formulario web solo se sirve cuando la petición NO pide datos. TODO
    // endpoint de consulta debe quedar excluido aquí: si se olvida alguno, esta
    // guarda lo intercepta y devuelve HTML donde el llamador espera JSON (que es
    // justo lo que pasaba con ?opciones y ?buscar).
    const pideDatos = Boolean(query.listar || query.opciones || query.buscar || query.adcol);

    if (metodo === 'GET' && !pideDatos) {
      const conGzip = aceptaGzip(event);
      // 'vary' es obligatorio al negociar gzip: sin él una caché compartida
      // podría entregarle el cuerpo comprimido a quien no sabe descomprimirlo.
      const cabeceras = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': CACHE_PAGINA,
        etag: conGzip ? paginaEtagGzip : paginaEtag,
        vary: 'Accept-Encoding',
      };

      // El navegador ya tiene esta misma versión: se le confirma con un 304 y se
      // ahorra el cuerpo entero.
      if (cabecera(event, 'if-none-match') === cabeceras.etag) {
        return { statusCode: 304, headers: cabeceras };
      }

      // Se sirve el gzip precalculado; si el cliente no lo acepta, el HTML tal cual.
      if (conGzip) {
        return {
          statusCode: 200,
          headers: { ...cabeceras, 'content-encoding': 'gzip' },
          body: paginaGzip.toString('base64'),
          isBase64Encoded: true,
        };
      }
      return { statusCode: 200, headers: cabeceras, body: paginaHtml };
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

      // El resumen lo calcula Mongo, no Node. Antes se traía un subdocumento por
      // cada estudiante de cada colegio (miles) solo para deducir periodos y
      // plataformas distintos: era la razón de que el selector de colegios
      // tardara en responder al abrir la pantalla. Con $setUnion viajan unas
      // pocas decenas de bytes por colegio.
      const docs = await col
        .aggregate([
          {
            $project: {
              nombre: 1, codigo: 1, region: 1, ciudad: 1, canton: 1,
              plataformas: {
                $setUnion: [
                  { $ifNull: ['$estudiantes.plataforma', []] },
                  { $ifNull: ['$docentes.plataforma', []] },
                ],
              },
              periodos: {
                $setUnion: [
                  { $ifNull: ['$estudiantes.periodo', []] },
                  { $ifNull: ['$docentes.periodo', []] },
                ],
              },
              estudiantes: { $size: { $ifNull: ['$estudiantes', []] } },
              docentes: { $size: { $ifNull: ['$docentes', []] } },
            },
          },
          { $sort: { nombre: 1 } },
        ])
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
          // $setUnion ya viene ordenado y sin repetidos; solo se quitan vacíos.
          plataformas: (d.plataformas || []).filter(Boolean),
          periodos: (d.periodos || []).filter(Boolean),
          estudiantes: d.estudiantes,
          docentes: d.docentes,
        }))
      );
    }

    // Valores que existen de verdad para un colegio y periodo, para poblar los
    // desplegables en cascada. También aquí filtra y deduplica Mongo: traer el
    // padrón entero para sacar una docena de grados sería tirar ancho de banda.
    if (metodo === 'GET' && query.opciones) {
      const { colegioId, periodo, grado } = query;
      if (!colegioId || !periodo) {
        return respuestaJson(400, { error: 'Elige un colegio y un periodo para ver los filtros' });
      }

      // Estudiantes y docentes viven en dos arreglos del mismo documento y con
      // la misma forma. Todo lo que sigue es idéntico salvo de cuál se lee, así
      // que el rol solo decide el nombre del campo.
      const campo = campoDelRol(query.rol);

      const col = await coleccionColegios();
      const delPeriodo = {
        $filter: {
          input: { $ifNull: [`$${campo}`, []] },
          as: 'e',
          cond: { $eq: ['$$e.periodo', periodo] },
        },
      };

      const [doc] = await col
        .aggregate([
          { $match: { _id: colegioId } },
          {
            $project: {
              _id: 0,
              grados: { $setUnion: [{ $map: { input: delPeriodo, as: 'e', in: '$$e.grado' } }, []] },
              // Los paralelos dependen del grado elegido: si ya hay uno, solo se
              // ofrecen los suyos.
              paralelos: {
                $setUnion: [
                  {
                    $map: {
                      input: {
                        $filter: {
                          input: { $ifNull: [`$${campo}`, []] },
                          as: 'e',
                          cond: grado
                            ? { $and: [{ $eq: ['$$e.periodo', periodo] }, { $eq: ['$$e.grado', grado] }] }
                            : { $eq: ['$$e.periodo', periodo] },
                        },
                      },
                      as: 'e',
                      in: '$$e.grupo',
                    },
                  },
                  [],
                ],
              },
              total: { $size: delPeriodo },
            },
          },
        ])
        .toArray();

      if (!doc) return respuestaJson(404, { error: 'Colegio no encontrado' });

      return respuestaJson(200, {
        grados: ordenarGrados((doc.grados || []).filter(Boolean)),
        paralelos: ordenarParalelos((doc.paralelos || []).filter(Boolean)),
        total: doc.total || 0,
      });
    }

    // Consultar credenciales: búsqueda real. Solo descifra la PÁGINA de
    // resultados devuelta, nunca el padrón completo del colegio. Sirve tanto a
    // estudiantes como a docentes; el parámetro `rol` elige el arreglo.
    if (metodo === 'GET' && query.buscar) {
      const { colegioId, periodo, grado, paralelo } = query;
      const campo = campoDelRol(query.rol);
      if (!colegioId || !periodo) {
        return respuestaJson(400, { error: 'Elige un colegio y un periodo para consultar credenciales' });
      }

      const col = await coleccionColegios();

      // El recorte por periodo/grado/paralelo lo hace Mongo. Traer el padrón
      // completo para descartarlo en Node encarecía cada consulta, y ahora los
      // filtros se aplican solos en cuanto el usuario cambia uno.
      const condiciones = [{ $eq: ['$$e.periodo', periodo] }];
      if (grado) condiciones.push({ $eq: ['$$e.grado', grado] });
      if (paralelo) condiciones.push({ $eq: ['$$e.grupo', paralelo] });

      const [doc] = await col
        .aggregate([
          { $match: { _id: colegioId } },
          {
            $project: {
              nombre: 1,
              codigo: 1,
              registros: {
                $filter: {
                  input: { $ifNull: [`$${campo}`, []] },
                  as: 'e',
                  cond: { $and: condiciones },
                },
              },
            },
          },
        ])
        .toArray();

      if (!doc) return respuestaJson(404, { error: 'Colegio no encontrado' });

      let filtrados = doc.registros || [];

      // El nombre se busca sobre TODO lo que quedó y antes de paginar: si se
      // aplicara después, solo miraría los 20 de la página actual y parecería
      // que el estudiante no existe.
      if (query.nombre && String(query.nombre).trim()) {
        filtrados = buscarPorNombre(filtrados, String(query.nombre));
      }

      const limite = Math.min(Math.max(parseInt(query.limite, 10) || 20, 1), 100);
      const pagina = Math.max(parseInt(query.pagina, 10) || 1, 1);
      const inicio = (pagina - 1) * limite;
      const slice = filtrados.slice(inicio, inicio + limite);

      const resultados = slice.map((e) => ({
        nombre: e.nombre,
        apellidos: e.apellidos,
        nombreCompleto: e.nombreCompleto,
        grado: e.grado,
        grupo: e.grupo,
        plataforma: e.plataforma,
        login: descifrar(e.login, config.cifrado.clave),
        contrasena: descifrar(e.contrasena, config.cifrado.clave),
      }));

      return respuestaJson(200, {
        colegio: { id: doc._id, nombre: doc.nombre, codigo: doc.codigo },
        periodo,
        rol: campo === 'docentes' ? 'docente' : 'estudiante',
        total: filtrados.length,
        pagina,
        limite,
        resultados,
      });
    }

    // Editar UN registro, de estudiante o de docente.
    //
    // Se identifica por plataforma + usuario actual dentro del periodo, que es
    // exactamente una fila de la tabla de resultados. Solo se tocan los campos
    // que vienen en la petición: el resto del registro queda intacto.
    if (metodo === 'POST' && query.editar) {
      const cuerpo = JSON.parse(
        event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}'
      );
      const { colegioId, periodo, plataforma, login, cambios } = cuerpo;
      const campo = campoDelRol(cuerpo.rol ?? query.rol);

      if (!colegioId || !periodo || !login) {
        return respuestaJson(400, { error: 'Faltan el colegio, el periodo o el usuario a editar' });
      }
      if (!cambios || typeof cambios !== 'object') {
        return respuestaJson(400, { error: 'No se indicó ningún cambio' });
      }

      const col = await coleccionColegios();
      const doc = await col.findOne({ _id: colegioId }, { projection: { nombre: 1, [campo]: 1 } });
      if (!doc) return respuestaJson(404, { error: 'Colegio no encontrado' });

      const mismaFila = (e) =>
        e.periodo === periodo &&
        String(e.plataforma || '') === String(plataforma || '') &&
        descifrar(e.login, config.cifrado.clave) === String(login);

      const indice = (doc[campo] || []).findIndex(mismaFila);
      if (indice === -1) {
        return respuestaJson(404, {
          error: `No se encontró ese ${campo === 'docentes' ? 'docente' : 'estudiante'} en el periodo indicado`,
        });
      }

      const actual = doc[campo][indice];
      const texto = (v) => (typeof v === 'string' ? v.trim() : '');
      const actualizado = { ...actual };

      // Nombre: se guarda entero y se recalcula el normalizado, que es el que
      // usa la búsqueda. Sin recalcularlo, el estudiante seguiría apareciendo
      // bajo su nombre viejo.
      const nombreNuevo = texto(cambios.nombreCompleto);
      if (nombreNuevo) {
        actualizado.nombreCompleto = nombreNuevo;
        actualizado.nombreNormalizado = normalizar(nombreNuevo);
      }

      // Un docente no tiene grado ni paralelo: si llegaran, se ignoran en vez de
      // inventarle un curso que la pantalla luego mostraría como suyo.
      if (campo === 'estudiantes') {
        if (texto(cambios.grado)) actualizado.grado = texto(cambios.grado);
        if (texto(cambios.grupo)) actualizado.grupo = texto(cambios.grupo);
      }

      if (texto(cambios.plataforma)) {
        const nueva = normalizar(cambios.plataforma);
        if (!config.plataformasPermitidas.includes(nueva)) {
          return respuestaJson(400, {
            error: `Plataforma "${cambios.plataforma}" no permitida. Solo: ${config.plataformasPermitidas.join(', ')}`,
          });
        }
        actualizado.plataforma = nueva;
      }

      // Credenciales: se vuelven a cifrar. Nunca se guardan en claro.
      if (texto(cambios.login)) actualizado.login = cifrar(texto(cambios.login), config.cifrado.clave);
      if (texto(cambios.contrasena)) actualizado.contrasena = cifrar(texto(cambios.contrasena), config.cifrado.clave);

      const registros = [...doc[campo]];
      registros[indice] = actualizado;
      await col.updateOne({ _id: colegioId }, { $set: { [campo]: registros, actualizadoEn: new Date() } });

      console.log(`[editar] colegio=${colegioId} periodo=${periodo} rol=${campo} usuario=${login}`);

      return respuestaJson(200, {
        colegio: { id: doc._id, nombre: doc.nombre },
        rol: campo === 'docentes' ? 'docente' : 'estudiante',
        // Se devuelve el registro ya actualizado —sin la contraseña cifrada—
        // para que la pantalla refresque la fila sin volver a consultar.
        estudiante: {
          nombreCompleto: actualizado.nombreCompleto,
          grado: actualizado.grado,
          grupo: actualizado.grupo,
          plataforma: actualizado.plataforma,
          login: descifrar(actualizado.login, config.cifrado.clave),
          contrasena: descifrar(actualizado.contrasena, config.cifrado.clave),
        },
      });
    }

    // Eliminar estudiantes de un colegio.
    //
    // Se borra SOLO lo que el usuario tenía delante: se identifica cada registro
    // por periodo + plataforma + login, que es exactamente una fila de la tabla
    // de resultados. No se acepta borrar "todo un grado" ni "todo un colegio":
    // una operación así, mal disparada, deja sin acceso a cientos de personas.
    // ── Credenciales ADCOL ──────────────────────────────────────────────────
    //
    // Un acceso administrativo por colegio, en su propia colección. Se consulta
    // entero y se filtra en Node: son ~550 documentos diminutos, así que paginar
    // en Mongo costaría más código del que ahorra.
    if (metodo === 'GET' && query.adcol) {
      const col = await coleccionAdcol();
      const docs = await col.find({}).toArray();

      const consulta = normalizar(query.nombre || '');
      const filtrados = consulta
        ? docs.filter(
            (d) =>
              String(d.nombreNormalizado || '').includes(consulta) ||
              String(d.codigo || '').toLowerCase().includes(consulta) ||
              String(d._id).toLowerCase().includes(consulta) ||
              normalizar(descifrar(d.usuario, config.cifrado.clave) || '').includes(consulta)
          )
        : docs;

      const region = normalizar(query.region || '');
      const porRegion = region ? filtrados.filter((d) => normalizar(d.region) === region) : filtrados;

      porRegion.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));

      const limite = Math.min(Math.max(parseInt(query.limite, 10) || 20, 1), 100);
      const pagina = Math.max(parseInt(query.pagina, 10) || 1, 1);
      const inicio = (pagina - 1) * limite;

      return respuestaJson(200, {
        total: porRegion.length,
        pagina,
        limite,
        regiones: [...new Set(docs.map((d) => d.region).filter(Boolean))].sort(),
        resultados: porRegion.slice(inicio, inicio + limite).map((d) => ({
          id: d._id,
          nombre: d.nombre,
          codigo: d.codigo || '',
          region: d.region || '',
          usuario: descifrar(d.usuario, config.cifrado.clave) || '',
          contrasena: descifrar(d.contrasena, config.cifrado.clave) || '',
          // Le ahorra a la pantalla repetir la regla de qué cuenta como
          // incompleto, y evita que las dos definiciones se separen.
          incompleto: !d.usuario || !d.contrasena,
          actualizadoEn: d.actualizadoEn || null,
        })),
      });
    }

    // Crear o modificar UNA credencial ADCOL.
    if (metodo === 'POST' && query.adcolGuardar) {
      const cuerpo = JSON.parse(
        event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}'
      );
      const texto = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

      const id = texto(cuerpo.id);
      const nombre = texto(cuerpo.nombre);
      if (!id) return respuestaJson(400, { error: 'Falta el id del colegio' });
      if (!nombre) return respuestaJson(400, { error: 'Falta el nombre del colegio' });

      const col = await coleccionAdcol();
      const existente = await col.findOne({ _id: id });

      if (cuerpo.crear && existente) {
        return respuestaJson(409, { error: `Ya existe una credencial ADCOL para el colegio ${id}` });
      }
      if (!cuerpo.crear && !existente) {
        return respuestaJson(404, { error: `No existe una credencial ADCOL para el colegio ${id}` });
      }

      const doc = {
        nombre,
        nombreNormalizado: normalizar(nombre),
        codigo: texto(cuerpo.codigo),
        region: texto(cuerpo.region),
        actualizadoEn: new Date(),
      };

      // Usuario y contraseña se cifran igual que las del padrón: son el acceso
      // administrativo de un colegio entero, no un dato menor.
      const usuario = texto(cuerpo.usuario);
      const contrasena = texto(cuerpo.contrasena);
      doc.usuario = usuario ? cifrar(usuario, config.cifrado.clave) : null;
      doc.contrasena = contrasena ? cifrar(contrasena, config.cifrado.clave) : null;

      await col.updateOne(
        { _id: id },
        { $set: doc, $setOnInsert: { creadoEn: new Date() } },
        { upsert: true }
      );

      console.log(`[adcol] ${existente ? 'editado' : 'creado'} colegio=${id}`);

      return respuestaJson(existente ? 200 : 201, {
        id,
        nombre,
        codigo: doc.codigo,
        region: doc.region,
        usuario,
        contrasena,
        incompleto: !usuario || !contrasena,
        creado: !existente,
      });
    }

    if (metodo === 'POST' && query.eliminar) {
      const cuerpo = JSON.parse(
        event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}'
      );
      const { colegioId, periodo } = cuerpo;
      const campo = campoDelRol(cuerpo.rol ?? query.rol);
      const objetivos = Array.isArray(cuerpo.estudiantes) ? cuerpo.estudiantes : [];

      if (!colegioId || !periodo) {
        return respuestaJson(400, { error: 'Faltan el colegio y el periodo' });
      }
      if (objetivos.length === 0) {
        return respuestaJson(400, { error: 'No se indicó ningún estudiante a eliminar' });
      }
      // Tope igual al de una página de resultados: si llega más, no viene de la
      // pantalla sino de una llamada armada a mano.
      if (objetivos.length > 100) {
        return respuestaJson(400, { error: 'No se pueden eliminar más de 100 registros a la vez' });
      }

      const col = await coleccionColegios();
      const doc = await col.findOne({ _id: colegioId }, { projection: { nombre: 1, [campo]: 1 } });
      if (!doc) return respuestaJson(404, { error: 'Colegio no encontrado' });

      // Clave de una fila de la tabla. El login va cifrado en la base, así que
      // se descifra para compararlo con lo que la pantalla mostró.
      const clave = (plataforma, login) => `${String(plataforma || '')}|${String(login || '')}`;
      const aBorrar = new Set(objetivos.map((o) => clave(o.plataforma, o.login)));

      const quedan = [];
      const eliminados = [];
      for (const e of doc[campo] || []) {
        const coincide =
          e.periodo === periodo && aBorrar.has(clave(e.plataforma, descifrar(e.login, config.cifrado.clave)));

        if (coincide) {
          // Se devuelve QUÉ se borró, nunca la contraseña: sirve para dejar
          // constancia y para que la pantalla confirme lo ocurrido.
          eliminados.push({
            nombreCompleto: e.nombreCompleto || [e.nombre, e.apellidos].filter(Boolean).join(' '),
            grado: e.grado,
            grupo: e.grupo,
            plataforma: e.plataforma,
          });
        } else {
          quedan.push(e);
        }
      }

      if (eliminados.length === 0) {
        return respuestaJson(404, {
          error: `No se encontró ninguno de esos ${campo} en el periodo indicado`,
          eliminados: 0,
        });
      }

      await col.updateOne({ _id: colegioId }, { $set: { [campo]: quedan, actualizadoEn: new Date() } });

      console.log(
        `[eliminar] colegio=${colegioId} periodo=${periodo} rol=${campo} borrados=${eliminados.length} ` +
          `restantes=${quedan.length}`
      );

      return respuestaJson(200, {
        colegio: { id: doc._id, nombre: doc.nombre },
        periodo,
        rol: campo === 'docentes' ? 'docente' : 'estudiante',
        eliminados: eliminados.length,
        detalle: eliminados,
        restantes: quedan.length,
      });
    }

    if (!event.body) {
      return respuestaJson(400, { error: 'Falta el body de la solicitud' });
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const body = JSON.parse(raw);

    const { codigoColegio, nombreColegio, region, canton, archivoBase64, nombreArchivo } = body;
    const ciudad = body.ciudad || body.provincia; // "Ciudad (Provincia)": se aceptan ambos nombres

    // El id de Pegasus es OPCIONAL: no todos los colegios lo tienen a la mano al
    // cargar. Si no viene, la identidad del documento es su código (que sí es
    // obligatorio y único). Así el _id nunca queda vacío.
    const idColegio = String(body.idColegio || '').trim() || String(codigoColegio || '').trim();

    // Tres formas de cargar: un Excel completo, UN usuario suelto desde el
    // formulario individual, o una LISTA JSON (la alimentación automática
    // desde el datalake, Luis 2026-10-20). El resto del flujo es idéntico.
    const esIndividual = Boolean(body.individual);
    const esLista = Array.isArray(body.registros);

    const requeridos = ['codigoColegio', 'nombreColegio', 'plataforma', 'periodo'];
    if (!esIndividual && !esLista) requeridos.push('archivoBase64');
    const faltantes = requeridos.filter((campo) => !body[campo]);
    if (faltantes.length > 0) {
      return respuestaJson(400, { error: `Faltan campos obligatorios: ${faltantes.join(', ')}` });
    }

    const plataforma = normalizar(body.plataforma);
    if (!config.plataformasPermitidas.includes(plataforma)) {
      const enEspera = config.plataformasEnEspera.includes(plataforma);
      return respuestaJson(400, {
        error: enEspera
          ? `La plataforma "${body.plataforma}" está implementada pero aún no habilitada para producción.`
          : `Plataforma "${body.plataforma}" no permitida. Solo se cargan credenciales de: ${config.plataformasPermitidas.join(', ')}`,
      });
    }

    const periodo = String(body.periodo).trim();
    if (!/^\d{4}-\d{4}$/.test(periodo)) {
      return respuestaJson(400, { error: `Periodo "${body.periodo}" inválido. Formato esperado: 2026-2027` });
    }

    let datos;
    if (esIndividual) {
      // Lanza un error 400 con el detalle si faltan login/contraseña/nombre.
      datos = registroIndividual(body.individual);
    } else if (esLista) {
      datos = registrosDesdeLista(body.registros);
    } else {
      if (nombreArchivo && !/\.(xlsx|xlsm|xltx|xltm)$/i.test(nombreArchivo)) {
        return respuestaJson(400, { error: 'El archivo debe ser Excel (.xlsx)' });
      }
      const buffer = Buffer.from(archivoBase64, 'base64');
      datos = parsearExcelCredenciales(buffer);
    }

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

    // Sincronización AUTORITATIVA (Luis, 2026-10-20): la lista entrante es la
    // verdad para esta plataforma+periodo. Se usa con ?sincronizar=1, para la
    // alimentación desde el datalake. Dos diferencias con fusionar():
    //
    //  1. CONSERVA la contraseña ya guardada cuando la entrante no trae. La
    //     clave se carga a mano y la alimentación automática viene sin ella;
    //     sin esto, cada sincronización borraría el trabajo manual.
    //  2. BORRA a quien ya no venga en la lista (los sobrantes), que es justo
    //     lo que fusionar() NO hace.
    //
    // El nombre, el grado y el grupo SÍ se actualizan con lo entrante: pueden
    // corregirse, y el login manda como identidad.
    const sincronizar = (guardados, filas) => {
      const previos = new Map();
      guardados.forEach((r) => previos.set(idDeGuardado(r), r));

      const vistos = new Set();
      const salida = [];
      const resumen = { filas: filas.length, nuevos: 0, actualizados: 0, sinCambios: 0, eliminados: 0 };

      for (const fila of filas) {
        const id = idDeFila(fila);
        if (vistos.has(id)) continue; // la lista podría traer el mismo login dos veces
        vistos.add(id);

        const antes = previos.get(id);
        if (!antes) {
          salida.push(preparar(fila));
          resumen.nuevos++;
          continue;
        }

        // Conserva la clave previa si la entrante no trae una.
        const clavePrevia = descifrar(antes.contrasena, config.cifrado.clave);
        const claveFinal = (fila.contrasena ?? '') !== '' ? fila.contrasena : clavePrevia;
        const nuevaFila = { ...fila, contrasena: claveFinal };
        salida.push(preparar(nuevaFila));

        const cambio =
          !mismoValor(antes.nombreCompleto, nuevaFila.nombreCompleto) ||
          !mismoValor(antes.grado, nuevaFila.grado) ||
          !mismoValor(antes.grupo, nuevaFila.grupo) ||
          !mismoValor(clavePrevia, claveFinal);
        if (cambio) resumen.actualizados++;
        else resumen.sinCambios++;
      }

      resumen.eliminados = guardados.filter((r) => !vistos.has(idDeGuardado(r))).length;
      return { registros: salida, resumen };
    };

    // En sincronización solo se reconcilia el rol que TRAE datos: una lista
    // vacía deja ese rol intacto, NO lo vacía. Así una sincronización de solo
    // estudiantes no borra a los docentes, y —más importante— un fallo que
    // devuelva cero filas no arrasa el padrón entero.
    const combinar = (guardados, filas) =>
      query.sincronizar && filas.length > 0 ? sincronizar(guardados, filas) : fusionar(guardados, filas);

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

    const fusEstudiantes = combinar(deEstaCarga(existente?.estudiantes), datos.estudiantes);
    const estudiantes = [...intactos(existente?.estudiantes), ...fusEstudiantes.registros];

    // Los docentes se tratan igual que los estudiantes. En sincronización, una
    // lista de solo estudiantes NO borra a los docentes, ni al revés: cada
    // carga trae su rol y sincronizar() solo reconcilia lo que recibe.
    const fusDocentes = combinar(deEstaCarga(existente?.docentes), datos.docentes);
    const docentes = [...intactos(existente?.docentes), ...fusDocentes.registros];

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
          docentes,
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
      // Cada hoja procesada con el rol (estudiantes/docentes) que se le asignó.
      hojasProcesadas: datos.hojasProcesadas,
      // Hojas que se ignoraron por no tener credenciales parseables.
      hojasIgnoradas: datos.hojasIgnoradas,
      // "actualizados" = ya existían y su contraseña cambió respecto a lo
      // guardado; "sinCambios" = venían en el Excel idénticos a lo que ya había.
      estudiantes: {
        ...fusEstudiantes.resumen,
        totalPeriodo: fusEstudiantes.registros.length,
        totalColegio: estudiantes.length,
      },
      docentes: {
        ...fusDocentes.resumen,
        totalPeriodo: fusDocentes.registros.length,
        totalColegio: docentes.length,
      },
      creado: resultado.upsertedId !== null,
    });
  } catch (err) {
    console.error(err);
    return respuestaJson(err.statusCode || 500, { error: err.message });
  }
};
