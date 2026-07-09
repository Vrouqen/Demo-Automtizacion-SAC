// Utilidades de comparación difusa de texto (sin dependencias externas).

export function normalizar(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes (marcas diacríticas tras NFD)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigramas(texto) {
  const s = texto.replace(/\s/g, '');
  const res = [];
  for (let i = 0; i < s.length - 1; i++) res.push(s.slice(i, i + 2));
  return res;
}

// Coeficiente de Dice sobre bigramas: 0 (nada) a 1 (idéntico).
export function similitudDice(a, b) {
  const x = bigramas(a);
  const y = bigramas(b);
  if (x.length === 0 || y.length === 0) return a === b ? 1 : 0;
  const mapa = new Map();
  for (const bg of x) mapa.set(bg, (mapa.get(bg) || 0) + 1);
  let coincidencias = 0;
  for (const bg of y) {
    const n = mapa.get(bg) || 0;
    if (n > 0) {
      coincidencias++;
      mapa.set(bg, n - 1);
    }
  }
  return (2 * coincidencias) / (x.length + y.length);
}

// Compara nombres ignorando el orden de las palabras (Juan Pérez ≈ Pérez Juan)
// y tolerando nombres incompletos (subconjunto de tokens).
export function similitudNombres(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;

  const directa = similitudDice(na, nb);
  const ordenada = similitudDice(
    na.split(' ').sort().join(' '),
    nb.split(' ').sort().join(' ')
  );

  // Cobertura de tokens: qué tan bien los tokens de la consulta (a)
  // aparecen dentro del nombre completo registrado (b).
  const tokensA = na.split(' ');
  const tokensB = nb.split(' ');
  let suma = 0;
  for (const ta of tokensA) {
    let mejor = 0;
    for (const tb of tokensB) {
      const s = similitudDice(ta, tb);
      if (s > mejor) mejor = s;
    }
    suma += mejor;
  }
  const cobertura = suma / tokensA.length;

  return Math.max(directa, ordenada, cobertura * 0.95);
}
