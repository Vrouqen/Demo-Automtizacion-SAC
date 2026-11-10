/**
 * Unifica Compartir y CREO en una sola plataforma, EDI, y elimina los
 * duplicados que ese desdoble dejó.
 *
 * EL PROBLEMA
 * El ETL cargaba como "compartir" alumnos que en realidad eran de CREO, así que
 * un mismo estudiante acabó dos veces en el padrón: una fila por cada etiqueta.
 * Como ambas plataformas son hoy lo mismo —EDI—, la distinción ya no significa
 * nada y las dos filas son la misma persona.
 *
 * QUÉ FILA SOBREVIVE
 * 1. Gana la que TIENE contraseña: una credencial sin clave no sirve para entrar.
 * 2. Si varias la tienen y usuario+contraseña son idénticos, da igual cuál quede.
 * 3. Si varias la tienen y DIFIEREN, no se toca ninguna. No son un duplicado del
 *    ETL sino dos cuentas distintas de la misma persona, y borrar una dejaría a
 *    alguien sin acceso sin manera de saber a quién. Se listan al final para que
 *    una persona decida.
 *
 * Se tratan estudiantes y docentes con las mismas reglas.
 *
 * Uso:
 *   node scripts/unificar-edi.mjs            (simulacro: no escribe nada)
 *   node scripts/unificar-edi.mjs --aplicar  (escribe)
 *
 * El simulacro es el modo por defecto a propósito: esto borra filas del padrón
 * de producción y no hay deshacer.
 */
import { writeFileSync } from 'node:fs';
import { coleccionColegios } from '../src/db/mongo.js';
import { descifrar } from '../src/utils/cifrado.js';
import { config, validarConfig } from '../src/config.js';

const aplicar = process.argv.includes('--aplicar');

/**
 * Antes de escribir se guarda el estado anterior de cada colegio que se va a
 * tocar. Son miles de filas borradas sin deshacer; con este archivo la
 * operación deja de ser irreversible. El contenido va cifrado igual que en la
 * base, así que el respaldo no expone credenciales en claro.
 */
const RESPALDO = process.env.RESPALDO_EDI || `respaldo-edi-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;

validarConfig();

/** Las dos etiquetas viejas pasan a ser la misma. El resto se queda como está. */
const UNIFICADAS = new Set(['compartir', 'creo']);
const DESTINO = 'edi';

const K = config.cifrado.clave;
const des = (v) => {
  try {
    return descifrar(v, K) || '';
  } catch {
    return '';
  }
};

/**
 * Identidad de una fila dentro de un colegio.
 *
 * El usuario manda cuando existe: dos filas con el mismo usuario en el mismo
 * periodo son la misma cuenta, por mucho que el grado o el nombre se hayan
 * escrito distinto en cada carga. Sin usuario no queda más remedio que mirar el
 * nombre y el curso.
 */
function identidad(e, plataforma) {
  const login = des(e.login);
  return login
    ? ['u', e.periodo || '', plataforma, login].join('|')
    : ['n', e.periodo || '', plataforma, e.nombreNormalizado || '', e.grado || '', e.grupo || ''].join('|');
}

const col = await coleccionColegios();
const docs = await col
  .find({}, { projection: { nombre: 1, estudiantes: 1, docentes: 1 } })
  .toArray();

const resumen = {
  colegios: docs.length,
  colegiosTocados: 0,
  renombradas: 0,
  eliminadas: 0,
  gruposAmbiguos: 0,
};
const ambiguos = [];
const respaldo = [];

for (const doc of docs) {
  const cambios = {};
  let tocado = false;

  for (const campo of ['estudiantes', 'docentes']) {
    const filas = doc[campo];
    if (!Array.isArray(filas) || filas.length === 0) continue;

    const grupos = new Map();

    for (const e of filas) {
      const original = String(e.plataforma || '').toLowerCase();
      const plataforma = UNIFICADAS.has(original) ? DESTINO : original;
      if (plataforma !== original) resumen.renombradas++;

      const fila = { ...e, plataforma };
      const id = identidad(e, plataforma);
      if (!grupos.has(id)) grupos.set(id, []);
      grupos.get(id).push(fila);
    }

    const quedan = [];

    for (const grupo of grupos.values()) {
      if (grupo.length === 1) {
        quedan.push(grupo[0]);
        continue;
      }

      const conClave = grupo.filter((e) => des(e.contrasena));

      // Ninguna sirve para entrar: se conserva una sola, da igual cuál.
      if (conClave.length === 0) {
        quedan.push(grupo[0]);
        resumen.eliminadas += grupo.length - 1;
        continue;
      }

      // Una sola utilizable: esa es la buena y las demás sobran.
      if (conClave.length === 1) {
        quedan.push(conClave[0]);
        resumen.eliminadas += grupo.length - 1;
        continue;
      }

      // Varias utilizables: solo se colapsan si son la MISMA credencial escrita
      // dos veces. Si no, se dejan todas y que lo mire una persona.
      const distintas = new Set(conClave.map((e) => des(e.login) + '\u0000' + des(e.contrasena)));

      if (distintas.size === 1) {
        quedan.push(conClave[0]);
        resumen.eliminadas += grupo.length - 1;
        continue;
      }

      resumen.gruposAmbiguos++;
      if (ambiguos.length < 80) {
        ambiguos.push({
          colegio: doc.nombre,
          campo,
          quien: conClave[0].nombreCompleto || conClave[0].nombreNormalizado || '(sin nombre)',
          periodo: conClave[0].periodo || '',
          cuentas: conClave.map((e) => `${e.plataforma}: ${des(e.login)} / ${des(e.contrasena)}`),
        });
      }
      quedan.push(...grupo);
    }

    // Solo se escribe el campo si algo cambió de verdad.
    if (quedan.length !== filas.length || quedan.some((f, i) => f.plataforma !== filas[i]?.plataforma)) {
      cambios[campo] = quedan;
      tocado = true;
    }
  }

  if (!tocado) continue;
  resumen.colegiosTocados++;

  if (aplicar) {
    // El respaldo se acumula con el estado PREVIO de lo que se va a sobrescribir.
    respaldo.push({
      _id: doc._id,
      nombre: doc.nombre,
      ...Object.fromEntries(Object.keys(cambios).map((c) => [c, doc[c]])),
    });
    await col.updateOne({ _id: doc._id }, { $set: { ...cambios, actualizadoEn: new Date() } });
  }
}

if (aplicar && respaldo.length) {
  writeFileSync(RESPALDO, JSON.stringify(respaldo), 'utf8');
  console.log(`\nRespaldo del estado anterior: ${RESPALDO} (${respaldo.length} colegios)`);
}

console.log(aplicar ? '=== APLICADO ===' : '=== SIMULACRO (no se escribió nada) ===');
console.log(`colegios revisados            : ${resumen.colegios}`);
console.log(`colegios con cambios          : ${resumen.colegiosTocados}`);
console.log(`filas renombradas a "${DESTINO}"     : ${resumen.renombradas}`);
console.log(`filas duplicadas eliminadas   : ${resumen.eliminadas}`);
console.log(`grupos ambiguos NO tocados    : ${resumen.gruposAmbiguos}`);

if (ambiguos.length) {
  console.log('\nCUENTAS DISTINTAS PARA LA MISMA PERSONA (se dejaron las dos):');
  for (const a of ambiguos) {
    console.log(`  ${a.colegio} · ${a.campo} · ${a.periodo}`);
    console.log(`    ${a.quien}`);
    a.cuentas.forEach((c) => console.log(`      ${c}`));
  }
  if (resumen.gruposAmbiguos > ambiguos.length) {
    console.log(`  …y ${resumen.gruposAmbiguos - ambiguos.length} más.`);
  }
}

if (!aplicar) console.log('\nRepite con --aplicar para escribir los cambios.');
process.exit(0);
