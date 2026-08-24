/**
 * Siembra el catálogo de colegios a partir del Excel de Pegasus.
 *
 * El objetivo es que el personal de configuración no tenga que teclear el
 * nombre ni el código de cada colegio al cargar credenciales: los elige de una
 * lista y solo completa lo que falte (ciudad, cantón).
 *
 * Lo que se siembra es el ESQUELETO del colegio, sin credenciales. Los alumnos
 * llegan después, con las cargas normales.
 *
 * Uso:
 *   node scripts/sembrar-colegios.mjs <ruta-del-excel>            (simulacro)
 *   node scripts/sembrar-colegios.mjs <ruta-del-excel> --aplicar  (escribe)
 *
 * Por defecto NO escribe nada: hay que pedirlo con --aplicar. Sembrar 405
 * documentos en la base equivocada sería un lío de deshacer.
 */
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { config, validarConfig } from '../src/config.js';
import { coleccionColegios } from '../src/db/mongo.js';
import { normalizar } from '../src/utils/similitud.js';

const [rutaExcel, ...flags] = process.argv.slice(2);
const aplicar = flags.includes('--aplicar');

if (!rutaExcel) {
  console.error('Falta la ruta del Excel.\n  node scripts/sembrar-colegios.mjs <archivo.xlsx> [--aplicar]');
  process.exit(1);
}

validarConfig();

// ── Lectura del Excel ──────────────────────────────────────────────────────
// Una hoja por región; cada fila es un colegio.
const libro = XLSX.read(readFileSync(rutaExcel), { type: 'buffer' });

const columna = (fila, ...nombres) => {
  for (const n of nombres) {
    const clave = Object.keys(fila).find((k) => normalizar(k) === normalizar(n));
    if (clave && String(fila[clave]).trim()) return String(fila[clave]).trim();
  }
  return '';
};

const filas = [];
for (const region of libro.SheetNames) {
  for (const cruda of XLSX.utils.sheet_to_json(libro.Sheets[region], { defval: '' })) {
    const id = columna(cruda, 'ID', 'Id colegio', 'IdColegio');
    const nombre = columna(cruda, 'Colegio', 'Nombre colegio', 'Nombre');
    if (!id || !nombre) continue;

    filas.push({
      id,
      nombre,
      codigo: columna(cruda, 'Codigo colegio', 'Código colegio', 'Codigo'),
      // El sistema del Excel es el que tiene HOY, no un límite: un colegio puede
      // sumar CREO, RLP o RS más adelante sin tocar este dato.
      sistema: normalizar(columna(cruda, 'Sistema de Suscripción', 'Sistema')),
      region,
    });
  }
}

// El id de Pegasus es la identidad del colegio. El código NO sirve: en el
// listado hay códigos compartidos por sedes distintas (una misma clave para
// tres colegios), así que usarlo los fusionaría en uno solo.
const porId = new Map();
const duplicados = [];
for (const f of filas) {
  if (porId.has(f.id)) duplicados.push(f);
  else porId.set(f.id, f);
}

console.log(`Excel: ${filas.length} filas → ${porId.size} colegios únicos`);
if (duplicados.length) console.log(`  (se ignoran ${duplicados.length} filas con id repetido)`);

const porRegion = {};
const porSistema = {};
for (const f of porId.values()) {
  porRegion[f.region] = (porRegion[f.region] || 0) + 1;
  porSistema[f.sistema || '(sin sistema)'] = (porSistema[f.sistema || '(sin sistema)'] || 0) + 1;
}
console.log('  por región :', JSON.stringify(porRegion));
console.log('  por sistema:', JSON.stringify(porSistema));

// ── Escritura ──────────────────────────────────────────────────────────────
const col = await coleccionColegios();
const existentes = new Set(
  (await col.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id))
);

const nuevos = [...porId.values()].filter((f) => !existentes.has(f.id));
const yaEstaban = porId.size - nuevos.length;

console.log(`\nEn la base: ${existentes.size} colegios`);
console.log(`  se crearían : ${nuevos.length}`);
console.log(`  ya existen  : ${yaEstaban} (se les actualiza nombre, código y región)`);

if (!aplicar) {
  console.log('\nSIMULACRO: no se ha escrito nada. Añade --aplicar para hacerlo de verdad.');
  console.log('Ejemplo de lo que se crearía:');
  for (const f of nuevos.slice(0, 3)) {
    console.log(`  ${f.id.padEnd(8)} ${f.codigo.padEnd(8)} ${f.region.padEnd(7)} ${f.nombre}`);
  }
  process.exit(0);
}

const operaciones = [...porId.values()].map((f) => ({
  updateOne: {
    filter: { _id: f.id },
    update: {
      // Estos vienen del listado oficial y mandan sobre lo que hubiera.
      $set: {
        codigo: f.codigo,
        nombre: f.nombre,
        nombreNormalizado: normalizar(f.nombre),
        region: f.region,
        regionNormalizada: normalizar(f.region),
        actualizadoEn: new Date(),
      },
      // Estos solo se ponen al CREAR. Si el colegio ya existe, se respeta lo que
      // el personal haya completado a mano y las credenciales ya cargadas: este
      // script no debe deshacer su trabajo.
      $setOnInsert: {
        ciudad: 'n/a',
        ciudadNormalizada: 'n/a',
        provincia: 'n/a',
        provinciaNormalizada: 'n/a',
        canton: 'n/a',
        cantonNormalizado: 'n/a',
        sistemaInicial: f.sistema,
        estudiantes: [],
        docentes: [],
        creadoEn: new Date(),
      },
    },
    upsert: true,
  },
}));

const r = await col.bulkWrite(operaciones, { ordered: false });
console.log(`\nHecho: ${r.upsertedCount} creados, ${r.modifiedCount} actualizados.`);
console.log(`Total de colegios en la base: ${await col.countDocuments()}`);
process.exit(0);
