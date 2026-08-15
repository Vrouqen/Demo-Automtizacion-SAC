import { normalizar } from './similitud.js';

/**
 * Búsqueda de personas por nombre dentro del padrón de un colegio.
 *
 * Está pensada para cómo escribe realmente quien atiende soporte: teclea trozos
 * del nombre, en cualquier orden, sin tildes y a veces con una letra cambiada
 * porque lo está copiando de un correo.
 *
 * Se busca únicamente sobre los nombres, que en la base están en claro. El
 * login NO entra en la búsqueda: está cifrado, y buscar en él obligaría a
 * descifrar el padrón entero (miles de registros) en cada consulta, que es
 * justo lo que este endpoint evita.
 *
 * Reglas, en orden de calidad del resultado:
 *  1. Cada palabra que escribe debe aparecer en el nombre como prefijo de
 *     alguna palabra. "cabrera angel" encuentra "Angel Fernando Cabrera
 *     Sigcho": el orden no importa y no hace falta la palabra completa.
 *  2. Si eso no devuelve nada, se reintenta tolerando erratas (coeficiente de
 *     Dice sobre bigramas). Así "cabrrera" sigue encontrando a "Cabrera", pero
 *     esa tolerancia solo entra cuando la búsqueda exacta falló: si entrara
 *     siempre, ensuciaría los resultados buenos con parecidos.
 *
 * Los resultados se ordenan por lo bien que calzan, no por el orden del padrón.
 */

/** Bigramas de una cadena ya normalizada. */
function bigramas(texto) {
  const lista = [];
  for (let i = 0; i < texto.length - 1; i++) lista.push(texto.slice(i, i + 2));
  return lista;
}

/** Coeficiente de Dice: 1 = idénticas, 0 = nada en común. Tolera erratas. */
export function similitudDice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const conteo = new Map();
  for (const bg of bigramas(a)) conteo.set(bg, (conteo.get(bg) || 0) + 1);

  let comunes = 0;
  for (const bg of bigramas(b)) {
    const n = conteo.get(bg) || 0;
    if (n > 0) {
      conteo.set(bg, n - 1);
      comunes++;
    }
  }
  return (2 * comunes) / (a.length - 1 + b.length - 1);
}

/**
 * Texto donde se busca, ya normalizado. Se juntan todas las variantes del
 * nombre porque no todos los padrones traen los mismos campos, y se quitan
 * repetidos para que un apellido presente en dos campos no puntúe doble.
 */
function textoBuscable(registro) {
  const partes = [
    registro.nombreCompleto,
    registro.nombre,
    registro.apellidos,
    registro.apellidoPaterno,
    registro.apellidoMaterno,
  ].filter(Boolean);
  const palabras = normalizar(partes.join(' ')).split(' ').filter(Boolean);
  return [...new Set(palabras)].join(' ');
}

/**
 * Puntúa un registro contra los términos buscados. Devuelve null si no calza.
 * Puntúa más alto cuando el término coincide con el INICIO de una palabra y
 * cuando coincide entera, para que "ana" ponga primero a "Ana Torres" antes que
 * a "Mariana Pérez".
 */
function puntuarExacto(palabrasTexto, terminos) {
  let total = 0;

  for (const termino of terminos) {
    let mejor = 0;
    for (const palabra of palabrasTexto) {
      if (palabra === termino) {
        mejor = Math.max(mejor, 3);
      } else if (palabra.startsWith(termino)) {
        // Cuanto más cubre del comienzo de la palabra, mejor.
        mejor = Math.max(mejor, 2 + termino.length / palabra.length);
      } else if (palabra.includes(termino)) {
        mejor = Math.max(mejor, 1);
      }
    }
    if (mejor === 0) return null; // un término sin calzar descarta el registro
    total += mejor;
  }

  return total;
}

/**
 * Filtra y ordena una lista de registros por el texto buscado.
 *
 * @param {Array} registros  padrón ya acotado (colegio, periodo, grado…)
 * @param {string} consulta  lo que escribió la persona
 * @returns {Array} registros que calzan, del que mejor calza al que menos
 */
export function buscarPorNombre(registros, consulta) {
  const terminos = normalizar(consulta || '').split(' ').filter(Boolean);
  if (terminos.length === 0) return registros;

  const indexados = registros.map((registro) => {
    const texto = textoBuscable(registro);
    return { registro, texto, palabras: texto.split(' ').filter(Boolean) };
  });

  // 1) Coincidencia exacta por prefijos: es lo que acierta el 95 % de las veces.
  const exactos = [];
  for (const item of indexados) {
    const puntaje = puntuarExacto(item.palabras, terminos);
    if (puntaje !== null) exactos.push({ registro: item.registro, puntaje });
  }

  if (exactos.length > 0) {
    return exactos.sort((a, b) => b.puntaje - a.puntaje).map((x) => x.registro);
  }

  // 2) Nada calzó: se reintenta tolerando erratas. El umbral es alto a
  //    propósito — más vale "sin resultados" que una lista de desconocidos.
  const consultaNorm = terminos.join(' ');
  const aproximados = [];
  for (const item of indexados) {
    let mejor = similitudDice(consultaNorm, item.texto);
    for (const palabra of item.palabras) {
      for (const termino of terminos) {
        mejor = Math.max(mejor, similitudDice(termino, palabra));
      }
    }
    if (mejor >= 0.62) aproximados.push({ registro: item.registro, puntaje: mejor });
  }

  return aproximados.sort((a, b) => b.puntaje - a.puntaje).map((x) => x.registro);
}
