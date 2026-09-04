import { coleccionColegios } from '../db/mongo.js';
import { config } from '../config.js';
import { normalizar, similitudNombres, similitudDice } from '../utils/similitud.js';
import { descifrar } from '../utils/cifrado.js';

const UMBRAL_COLEGIO = 0.55;
const UMBRAL_SUGERENCIA_COLEGIO = 0.3;
// Si el segundo mejor colegio queda a menos de este margen del primero, se
// consideran homónimos/ambiguos y hay que pedir al usuario que desambigüe.
const MARGEN_HOMONIMOS = 0.08;
const UMBRAL_ESTUDIANTE_OK = 0.82;
const UMBRAL_ESTUDIANTE_CANDIDATO = 0.45;

function resumenColegio(d) {
  return {
    id: d._id,
    codigo: d.codigo,
    nombre: d.nombre,
    region: d.region || 'n/a',
    ciudad: d.ciudad || d.provincia || 'n/a',
    canton: d.canton || 'n/a',
  };
}

export async function listarColegios() {
  const col = await coleccionColegios();
  const docs = await col
    .find({}, { projection: { nombre: 1, codigo: 1, region: 1, ciudad: 1, provincia: 1, canton: 1 } })
    .toArray();
  return docs.map(resumenColegio);
}

function tieneValor(v) {
  const n = normalizar(v);
  return n && n !== 'n/a' && n !== 'na';
}

// Suma al score si el campo de ubicación coincide; resta si claramente difiere.
function ajustePorUbicacion(valorConsulta, valorColegio, peso) {
  if (!tieneValor(valorConsulta) || !tieneValor(valorColegio)) return 0;
  const sim = similitudDice(normalizar(valorConsulta), normalizar(valorColegio));
  return sim >= 0.7 ? peso : -peso * 1.5;
}

/**
 * Busca el colegio por nombre (coincidencia difusa), usando región, ciudad
 * (provincia) y cantón para desempatar. Detecta HOMÓNIMOS: si dos o más
 * colegios quedan con puntaje alto y muy parecido (ej. dos "Unidad Educativa
 * Santa María" en cantones distintos), no adivina — devuelve las opciones con
 * su ubicación para que el usuario confirme cuál es.
 */
export async function buscarColegio({ colegio, region, ciudad, canton }) {
  const col = await coleccionColegios();
  // Para el match del nombre solo necesitamos identificación y ubicación; NO
  // traemos el padrón de estudiantes (cada colegio arrastra el suyo completo,
  // con credenciales cifradas). Así el escaneo difuso —que recorre todos los
  // colegios— mueve kilobytes en vez de megabytes.
  const docs = await col
    .find({}, { projection: { nombre: 1, codigo: 1, region: 1, ciudad: 1, provincia: 1, canton: 1 } })
    .toArray();
  if (docs.length === 0) {
    return { status: 'SIN_COLEGIOS', mensaje: 'No hay colegios cargados en la base de datos.' };
  }

  const puntuados = docs
    .map((d) => {
      let score = similitudNombres(colegio, d.nombre);
      score += ajustePorUbicacion(ciudad, d.ciudad || d.provincia, 0.1);
      score += ajustePorUbicacion(canton, d.canton, 0.12);
      score += ajustePorUbicacion(region, d.region, 0.05);
      return { doc: d, score };
    })
    .sort((a, b) => b.score - a.score);

  const mejor = puntuados[0];

  if (mejor.score >= UMBRAL_COLEGIO) {
    const empatados = puntuados.filter(
      (p) => p.score >= UMBRAL_COLEGIO && p.score >= mejor.score - MARGEN_HOMONIMOS
    );
    if (empatados.length > 1) {
      return {
        status: 'HOMONIMOS',
        opciones: empatados.slice(0, 5).map((p) => resumenColegio(p.doc)),
        detalle:
          'Hay más de un colegio con nombre igual o muy parecido. Pide al usuario confirmar cuál es usando la ciudad (provincia) y el cantón.',
      };
    }
    return { status: 'OK', colegio: mejor.doc, score: mejor.score };
  }

  const sugerencias = puntuados
    .filter((p) => p.score >= UMBRAL_SUGERENCIA_COLEGIO)
    .slice(0, 5)
    .map((p) => resumenColegio(p.doc));

  return { status: 'COLEGIO_NO_ENCONTRADO', sugerencias };
}

/**
 * Busca las credenciales de un estudiante.
 * Retorna un objeto con status:
 *  - OK: coincidencia única y confiable (incluye credenciales descifradas)
 *  - CANDIDATOS: varias coincidencias posibles (sin credenciales; pedir más datos)
 *  - ESTUDIANTE_NO_ENCONTRADO
 *  - HOMONIMOS: varios colegios con el mismo nombre; pedir ciudad/cantón
 *  - COLEGIO_NO_ENCONTRADO (con sugerencias de colegios parecidos)
 */
export async function buscarEstudiante(args) {
  return buscarPersona({ ...args, rol: 'estudiante' });
}

/**
 * Credenciales de un DOCENTE.
 *
 * Los docentes viven en el mismo documento del colegio, en su propio arreglo y
 * con el mismo cifrado. La única diferencia real es que no tienen grado ni
 * paralelo: nadie puede aportarlos ni sirven para desempatar homónimos, así que
 * aquí solo pesa el nombre.
 */
export async function buscarDocente(args) {
  return buscarPersona({ ...args, rol: 'docente' });
}

/**
 * Motor común de las dos búsquedas anteriores.
 *
 * Estudiantes y docentes se buscan igual —mismo colegio, mismo puntaje por
 * nombre, mismos umbrales— y separarlos en dos funciones gemelas garantizaba
 * que una se arreglara y la otra no.
 */
async function buscarPersona({ nombreCompleto, nivel, paralelo, colegio, region, ciudad, canton, rol }) {
  const esDocente = rol === 'docente';
  const campo = esDocente ? 'docentes' : 'estudiantes';
  const ETIQUETA = esDocente ? 'DOCENTE' : 'ESTUDIANTE';

  const resColegio = await buscarColegio({ colegio, region, ciudad, canton });
  if (resColegio.status !== 'OK') return resColegio;

  // buscarColegio devolvió el colegio "liviano" (sin padrón). Ahora sí traemos
  // el padrón de ESE único colegio para buscar a la persona.
  const col = await coleccionColegios();
  const docColegio = await col.findOne(
    { _id: resColegio.colegio._id },
    { projection: { nombre: 1, region: 1, ciudad: 1, provincia: 1, canton: 1, [campo]: 1 } }
  );
  let estudiantes = docColegio?.[campo] || [];
  if (estudiantes.length === 0) {
    return {
      status: `${ETIQUETA}_NO_ENCONTRADO`,
      colegio: docColegio.nombre,
      detalle: `El colegio no tiene ${campo} cargados.`,
    };
  }

  // El grado y el paralelo NO filtran: solo suman puntos.
  //
  // Filtrarlos descartaba al estudiante correcto cuando el usuario los escribe
  // de otra forma que el Excel, que es casi siempre. Un caso real: el padre puso
  // paralelo "Contabilidad" y en la base figura "Gestion Financiera y Contable";
  // el filtro dejó fuera a su hija y dentro a 259 alumnos de otros paralelos, así
  // que ni siquiera se activó el respaldo de "si vacía la lista, ignórala".
  //
  // Como bonificación cumplen su papel —desempatar entre homónimos— sin poder
  // esconder a nadie: el nombre sigue mandando.
  const coincideCampo = (e, campo, valor) => {
    if (!valor) return false;
    const c = normalizar(e[campo]);
    const v = normalizar(valor);
    if (!c || !v) return false;
    if (c.includes(v) || v.includes(c) || similitudDice(c, v) >= 0.6) return true;
    // "Contabilidad" contra "Gestion Financiera y Contable": basta con que
    // compartan una palabra con raíz común.
    const palabras = (t) => t.split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 4);
    return palabras(v).some((a) => palabras(c).some((b) => a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))));
  };

  const BONIFICACION = 0.05;

  const puntuados = estudiantes
    .map((e) => ({
      est: e,
      score:
        similitudNombres(nombreCompleto, e.nombreCompleto) +
        (!esDocente && coincideCampo(e, 'grado', nivel) ? BONIFICACION : 0) +
        (!esDocente && coincideCampo(e, 'grupo', paralelo) ? BONIFICACION : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const mejor = puntuados[0];
  const segundo = puntuados[1];

  const esUnicoConfiable =
    mejor && mejor.score >= UMBRAL_ESTUDIANTE_OK && (!segundo || segundo.score < mejor.score - 0.1);

  if (esUnicoConfiable) {
    const e = mejor.est;
    return {
      status: 'OK',
      colegio: docColegio.nombre,
      ciudad: docColegio.ciudad || docColegio.provincia,
      canton: docColegio.canton,
      rol: esDocente ? 'docente' : 'estudiante',
      estudiante: {
        nombreCompleto: e.nombreCompleto,
        // Un docente no tiene curso. Devolver los campos vacíos hacía que el
        // modelo los escribiera en el correo como "Grado: undefined".
        ...(esDocente ? {} : { grado: e.grado, grupo: e.grupo }),
        plataforma: e.plataforma,
        // Las credenciales viven cifradas en Mongo; se descifran solo aquí,
        // al momento de responder al usuario autorizado.
        login: descifrar(e.login, config.cifrado.clave),
        contrasena: descifrar(e.contrasena, config.cifrado.clave),
      },
      score: mejor.score,
    };
  }

  const candidatos = puntuados.filter((p) => p.score >= UMBRAL_ESTUDIANTE_CANDIDATO).slice(0, 5);

  if (candidatos.length > 0) {
    // SEGURIDAD: NO se devuelven los nombres, grados ni ningún dato de los
    // posibles coincidentes. Serían datos de OTROS estudiantes, que quien
    // escribe no tiene por qué conocer — listarlos es una fuga de datos
    // personales. Solo se informa que hubo coincidencias parciales para que el
    // asistente pida al usuario que precise los datos del SUYO.
    return {
      status: 'CANDIDATOS',
      colegio: docColegio.nombre,
      cantidad: candidatos.length,
      detalle: esDocente
        ? 'Hay más de una coincidencia parcial. NO reveles ni enumeres nombres de docentes: ' +
          'pide al usuario su nombre COMPLETO tal cual consta en la institución y vuelve a buscar.'
        : 'Hay más de una coincidencia parcial. NO reveles ni enumeres nombres de estudiantes: ' +
          'pide al usuario el nombre COMPLETO tal cual está matriculado, el nivel/grado y el paralelo, ' +
          'y vuelve a buscar con esos datos.',
    };
  }

  return { status: `${ETIQUETA}_NO_ENCONTRADO`, colegio: docColegio.nombre };
}

/**
 * Cantidad de estudiantes activos de un colegio de Ecuador.
 * Un estudiante está ACTIVO cuando tiene credenciales de acceso cargadas. Se
 * deduce aquí, de la presencia del login: apps/carga-credenciales solo sube
 * credenciales y no guarda ningún estado. Deducirlo en vez de leer una marca
 * guardada también hace que los datos cargados con versiones anteriores se
 * cuenten bien, sin necesidad de volver a subir sus Excels.
 * `idColegio` es el id del colegio en Pegasus (el _id del documento).
 */
export async function contarEstudiantesActivos({ idColegio }) {
  const col = await coleccionColegios();
  // Basta plataforma + presencia de login; el login viene cifrado y aquí no se
  // descifra, solo se mira si existe.
  const doc = await col.findOne(
    { $or: [{ _id: idColegio }, { codigo: idColegio }] },
    {
      projection: {
        nombre: 1, codigo: 1, region: 1, ciudad: 1, provincia: 1, canton: 1,
        'estudiantes.plataforma': 1, 'estudiantes.login': 1,
      },
    }
  );
  if (!doc) {
    return { status: 'COLEGIO_NO_ENCONTRADO', idColegio };
  }

  const estudiantes = doc.estudiantes || [];
  const esActivo = (e) => Boolean(e.login);

  const porPlataforma = {};
  let activos = 0;
  for (const e of estudiantes) {
    const p = e.plataforma || 'sin_plataforma';
    if (!porPlataforma[p]) porPlataforma[p] = { total: 0, activos: 0 };
    porPlataforma[p].total++;
    if (esActivo(e)) {
      activos++;
      porPlataforma[p].activos++;
    }
  }

  return {
    status: 'OK',
    colegio: resumenColegio(doc),
    totalEstudiantes: estudiantes.length,
    estudiantesActivos: activos,
    estudiantesInactivos: estudiantes.length - activos,
    porPlataforma,
  };
}
