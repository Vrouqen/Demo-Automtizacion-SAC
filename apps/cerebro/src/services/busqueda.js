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
  // traemos estudiantes/docentes (cada colegio arrastra su padrón completo con
  // credenciales cifradas). Así el escaneo difuso —que recorre todos los
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
export async function buscarEstudiante({ nombreCompleto, nivel, paralelo, colegio, region, ciudad, canton }) {
  const resColegio = await buscarColegio({ colegio, region, ciudad, canton });
  if (resColegio.status !== 'OK') return resColegio;

  // buscarColegio devolvió el colegio "liviano" (sin padrón). Ahora sí traemos
  // el padrón de ESE único colegio para buscar al estudiante.
  const col = await coleccionColegios();
  const docColegio = await col.findOne(
    { _id: resColegio.colegio._id },
    { projection: { nombre: 1, region: 1, ciudad: 1, provincia: 1, canton: 1, estudiantes: 1 } }
  );
  let estudiantes = docColegio?.estudiantes || [];
  if (estudiantes.length === 0) {
    return {
      status: 'ESTUDIANTE_NO_ENCONTRADO',
      colegio: docColegio.nombre,
      detalle: 'El colegio no tiene estudiantes cargados.',
    };
  }

  // Filtro suave por nivel/grado y paralelo/grupo: si el filtro vacía la
  // lista, se ignora (los datos del Excel pueden variar en formato).
  const filtrar = (lista, campo, valor) => {
    if (!valor) return lista;
    const v = normalizar(valor);
    const filtrada = lista.filter((e) => {
      const c = normalizar(e[campo]);
      return c && (c.includes(v) || v.includes(c) || similitudDice(c, v) >= 0.6);
    });
    return filtrada.length > 0 ? filtrada : lista;
  };
  estudiantes = filtrar(estudiantes, 'grado', nivel);
  estudiantes = filtrar(estudiantes, 'grupo', paralelo);

  const puntuados = estudiantes
    .map((e) => ({ est: e, score: similitudNombres(nombreCompleto, e.nombreCompleto) }))
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
      estudiante: {
        nombreCompleto: e.nombreCompleto,
        grado: e.grado,
        grupo: e.grupo,
        plataforma: e.plataforma,
        // Las credenciales viven cifradas en Mongo; se descifran solo aquí,
        // al momento de responder al usuario autorizado.
        login: descifrar(e.login, config.cifrado.clave),
        contrasena: descifrar(e.contrasena, config.cifrado.clave),
      },
      score: mejor.score,
    };
  }

  const candidatos = puntuados
    .filter((p) => p.score >= UMBRAL_ESTUDIANTE_CANDIDATO)
    .slice(0, 5)
    .map((p) => ({
      nombreCompleto: p.est.nombreCompleto,
      grado: p.est.grado,
      grupo: p.est.grupo,
      score: Number(p.score.toFixed(2)),
    }));

  if (candidatos.length > 0) {
    return {
      status: 'CANDIDATOS',
      colegio: docColegio.nombre,
      candidatos,
      detalle:
        'Hay coincidencias parciales. Confirma con el usuario el nombre completo, nivel o paralelo y vuelve a buscar.',
    };
  }

  return { status: 'ESTUDIANTE_NO_ENCONTRADO', colegio: docColegio.nombre };
}

/**
 * Cantidad de estudiantes activos de un colegio de Ecuador.
 * Un estudiante está ACTIVO cuando tiene PIN asociado (marca "activo" que
 * calcula apps/carga-credenciales al subir el Excel; para datos antiguos sin
 * la marca, se considera activo si la fila trae PIN).
 * `idColegio` es el id del colegio en Pegasus (el _id del documento).
 */
export async function contarEstudiantesActivos({ idColegio }) {
  const col = await coleccionColegios();
  // Para contar activos solo necesitamos plataforma + activo + presencia de PIN
  // de cada estudiante; excluimos login/contraseña (blobs cifrados) y todo el
  // padrón de docentes de la respuesta.
  const doc = await col.findOne(
    { $or: [{ _id: idColegio }, { codigo: idColegio }] },
    {
      projection: {
        nombre: 1, codigo: 1, region: 1, ciudad: 1, provincia: 1, canton: 1,
        'estudiantes.plataforma': 1, 'estudiantes.activo': 1, 'estudiantes.pin': 1,
      },
    }
  );
  if (!doc) {
    return { status: 'COLEGIO_NO_ENCONTRADO', idColegio };
  }

  const estudiantes = doc.estudiantes || [];
  const esActivo = (e) => e.activo === true || (e.activo === undefined && Boolean(e.pin));

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
