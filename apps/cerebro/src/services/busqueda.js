import { coleccionColegios } from '../db/mongo.js';
import { normalizar, similitudNombres, similitudDice } from '../utils/similitud.js';

const UMBRAL_COLEGIO = 0.55;
const UMBRAL_SUGERENCIA_COLEGIO = 0.3;
const UMBRAL_ESTUDIANTE_OK = 0.82;
const UMBRAL_ESTUDIANTE_CANDIDATO = 0.45;

export async function listarColegios() {
  const col = await coleccionColegios();
  const docs = await col
    .find({}, { projection: { nombre: 1, codigo: 1, provincia: 1 } })
    .toArray();
  return docs.map((d) => ({
    id: d._id,
    codigo: d.codigo,
    nombre: d.nombre,
    provincia: d.provincia,
  }));
}

/**
 * Busca el colegio por nombre (coincidencia difusa). Si se da provincia
 * (y no es "n/a"), se usa para desempatar/priorizar, no para excluir de plano.
 */
export async function buscarColegio({ colegio, provincia }) {
  const col = await coleccionColegios();
  const docs = await col.find({}).toArray();
  if (docs.length === 0) {
    return { status: 'SIN_COLEGIOS', mensaje: 'No hay colegios cargados en la base de datos.' };
  }

  const provNorm = normalizar(provincia);
  const conProvincia = provNorm && provNorm !== 'n/a' && provNorm !== 'na';

  const puntuados = docs
    .map((d) => {
      let score = similitudNombres(colegio, d.nombre);
      if (conProvincia) {
        const provColegio = normalizar(d.provincia);
        if (provColegio && provColegio !== 'n/a' && provColegio !== 'na') {
          const simProv = similitudDice(provNorm, provColegio);
          // Provincia coincidente suma; provincia claramente distinta resta.
          score += simProv >= 0.7 ? 0.1 : -0.15;
        }
      }
      return { doc: d, score };
    })
    .sort((a, b) => b.score - a.score);

  const mejor = puntuados[0];
  if (mejor.score >= UMBRAL_COLEGIO) {
    return { status: 'OK', colegio: mejor.doc, score: mejor.score };
  }

  const sugerencias = puntuados
    .filter((p) => p.score >= UMBRAL_SUGERENCIA_COLEGIO)
    .slice(0, 5)
    .map((p) => ({ nombre: p.doc.nombre, provincia: p.doc.provincia }));

  return { status: 'COLEGIO_NO_ENCONTRADO', sugerencias };
}

/**
 * Busca las credenciales de un estudiante.
 * Retorna un objeto con status:
 *  - OK: coincidencia única y confiable (incluye credenciales)
 *  - CANDIDATOS: varias coincidencias posibles (sin credenciales; pedir más datos)
 *  - ESTUDIANTE_NO_ENCONTRADO
 *  - COLEGIO_NO_ENCONTRADO (con sugerencias de colegios parecidos)
 */
export async function buscarEstudiante({ nombreCompleto, nivel, paralelo, colegio, provincia }) {
  const resColegio = await buscarColegio({ colegio, provincia });
  if (resColegio.status !== 'OK') return resColegio;

  const docColegio = resColegio.colegio;
  let estudiantes = docColegio.estudiantes || [];
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
      provincia: docColegio.provincia,
      estudiante: {
        nombreCompleto: e.nombreCompleto,
        grado: e.grado,
        grupo: e.grupo,
        login: e.login,
        contrasena: e.contrasena,
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
