import { normalizar } from './similitud.js';

/**
 * Orden pedagógico de los grados. Los desplegables deben mostrarlos en este
 * orden y no alfabéticamente, donde "10mo" cae antes que "2do" y la lista se
 * vuelve inútil para quien la usa.
 *
 * Referencia del orden esperado:
 *   Inicial 3 años · Inicial 4 años
 *   1ro … 10mo de Básica
 *   1º- Primero · 2º- Segundo · 3º- Tercero Bachillerato
 *
 * No se comparan las etiquetas literalmente: vienen de Excel cargados por
 * distintas personas y cambian de un colegio a otro ("1ro de Básica", "1RO DE
 * BASICA", "Primero de Básica"). Se deduce la etapa y el número, que es lo
 * único estable.
 */

/** Etapas, en el orden en que deben aparecer. */
const INICIAL = 1000;
const BASICA = 2000;
const BACHILLERATO = 3000;
const DESCONOCIDO = 9000;

/** Ordinales escritos con letra, para etiquetas que no traen el número. */
const ORDINALES = {
  primero: 1, primera: 1, uno: 1,
  segundo: 2, segunda: 2, dos: 2,
  tercero: 3, tercera: 3, tres: 3,
  cuarto: 4, cuarta: 4, cuatro: 4,
  quinto: 5, quinta: 5, cinco: 5,
  sexto: 6, sexta: 6, seis: 6,
  septimo: 7, septima: 7, siete: 7,
  octavo: 8, octava: 8, ocho: 8,
  noveno: 9, novena: 9, nueve: 9,
  decimo: 10, decima: 10, diez: 10,
};

/**
 * Cómo se escribe cada etapa en los Excel de los colegios.
 *
 * Las siglas van con límite de palabra: sin él, "bt" casaría dentro de
 * cualquier palabra que la contenga y colocaría mal el grado.
 *
 * Bachillerato cubre todas sus variantes —general (BGU), técnico (BT) e
 * internacional (BI)—, porque para ordenar solo importa la etapa y el año: un
 * "1ro BT" va junto a un "1ro BGU", no al final de la lista.
 */
const RE_BASICA = /\bbasica\b|\begb\b|\bb\b\s*\d/;
const RE_BACHILLERATO = /bachillerato|\bbgu\b|\bbt\b|\bbi\b|\btecnico\b/;

/** Número del grado: el dígito si lo trae, si no el ordinal en letra. */
function numeroDe(etiquetaNormalizada) {
  const digito = etiquetaNormalizada.match(/\d+/);
  if (digito) return parseInt(digito[0], 10);

  for (const palabra of etiquetaNormalizada.split(' ')) {
    if (ORDINALES[palabra] !== undefined) return ORDINALES[palabra];
  }
  return 0;
}

/**
 * Posición de un grado dentro del orden pedagógico. Cuanto menor, más arriba.
 * Lo que no se reconoce va al final, nunca intercalado.
 */
export function ordenGrado(etiqueta) {
  const texto = normalizar(etiqueta);
  if (!texto) return DESCONOCIDO;

  if (texto.includes('inicial')) return INICIAL + numeroDe(texto);
  if (RE_BASICA.test(texto)) return BASICA + numeroDe(texto);
  if (RE_BACHILLERATO.test(texto)) return BACHILLERATO + numeroDe(texto);

  return DESCONOCIDO;
}

/** Ordena grados por etapa y número; los no reconocidos, alfabéticamente al final. */
export function ordenarGrados(grados) {
  return [...grados].sort((a, b) => {
    const diferencia = ordenGrado(a) - ordenGrado(b);
    return diferencia !== 0 ? diferencia : String(a).localeCompare(String(b), 'es');
  });
}

/**
 * Ordena paralelos de forma natural: "A, B, C" y "1, 2, 10" (no "1, 10, 2").
 */
export function ordenarParalelos(paralelos) {
  return [...paralelos].sort((a, b) =>
    String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' })
  );
}
