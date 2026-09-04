/**
 * Siembra las credenciales ADCOL a partir del Excel de colegios.
 *
 * ADCOL es UN acceso administrativo POR COLEGIO, distinto del padrón de
 * alumnos y docentes: por eso vive en su propia colección.
 *
 * Del Excel se conserva el nombre TAL CUAL viene, porque mezcla el código con
 * el nombre en tres formatos distintos ("7620| Juan Bautista", "8300 John
 * Osteen", "4364- Jean Piaget") y normalizarlo a la fuerza destruiría el
 * original. El código se extrae aparte cuando se puede reconocer, y si no, se
 * deja vacío: es preferible un campo vacío a un código inventado.
 *
 * Las filas a las que les falta el usuario o la contraseña SE CARGAN igual,
 * con el campo vacío. Omitirlas escondería el problema: así salen en la lista
 * marcadas como incompletas y un digital puede completarlas.
 *
 * Uso:
 *   node scripts/sembrar-adcol.mjs <ruta-del-excel>            (simulacro)
 *   node scripts/sembrar-adcol.mjs <ruta-del-excel> --aplicar  (escribe)
 *
 * Por defecto NO escribe: hay que pedirlo con --aplicar.
 */
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { config, validarConfig } from '../src/config.js';
import { coleccionAdcol } from '../src/db/mongo.js';
import { normalizar } from '../src/utils/similitud.js';
import { cifrar } from '../src/utils/cifrado.js';

const [rutaExcel, ...flags] = process.argv.slice(2);
const aplicar = flags.includes('--aplicar');

if (!rutaExcel) {
  console.error('Falta la ruta del Excel.\n  node scripts/sembrar-adcol.mjs <archivo.xlsx> [--aplicar]');
  process.exit(1);
}

validarConfig();

const libro = XLSX.read(readFileSync(rutaExcel), { type: 'buffer' });

const columna = (fila, ...nombres) => {
  for (const n of nombres) {
    const clave = Object.keys(fila).find((k) => normalizar(k) === normalizar(n));
    if (clave !== undefined) return String(fila[clave] ?? '').trim();
  }
  return '';
};

/** El código del colegio va incrustado al principio del nombre, con separadores variables. */
function codigoDelNombre(nombre) {
  const m = String(nombre).match(/^\s*(\d{3,6})\s*[|\-]?\s+|^\s*(\d{3,6})\s*\|/);
  return m ? (m[1] || m[2] || '').trim() : '';
}

// Cada hoja es una región.
const filas = [];
for (const hoja of libro.SheetNames) {
  for (const cruda of XLSX.utils.sheet_to_json(libro.Sheets[hoja], { defval: '' })) {
    const id = columna(cruda, 'ID');
    const nombre = columna(cruda, 'NOMBRE');
    if (!id || !nombre) continue;
    filas.push({
      id,
      nombre,
      codigo: codigoDelNombre(nombre),
      region: hoja.trim(),
      usuario: columna(cruda, 'USUARIO', 'USER'),
      contrasena: columna(cruda, 'CONTRASEÑA', 'CONTRASENA', 'PASSWORD', 'CLAVE'),
    });
  }
}

// El Excel trae filas repetidas; gana la última, que es lo mismo que haría la
// base al escribirlas en orden.
const porId = new Map(filas.map((f) => [f.id, f]));
const registros = [...porId.values()];

const incompletos = registros.filter((r) => !r.usuario || !r.contrasena);
const sinCodigo = registros.filter((r) => !r.codigo);

console.log(`Hojas: ${libro.SheetNames.join(', ')}`);
console.log(`Filas leídas: ${filas.length}  |  colegios únicos: ${registros.length}`);
console.log(`Sin código reconocible en el nombre: ${sinCodigo.length}`);
console.log(`Incompletos (falta usuario o contraseña): ${incompletos.length}`);
for (const r of incompletos) {
  console.log(`   ${r.id} | ${r.nombre} | usuario="${r.usuario}" contraseña="${r.contrasena}"`);
}

if (!aplicar) {
  console.log('\nSIMULACRO: no se escribió nada. Repite con --aplicar para guardar.');
  process.exit(0);
}

const col = await coleccionAdcol();
let creados = 0;
let actualizados = 0;

for (const r of registros) {
  const existe = await col.findOne({ _id: r.id }, { projection: { _id: 1 } });
  await col.updateOne(
    { _id: r.id },
    {
      $set: {
        nombre: r.nombre,
        nombreNormalizado: normalizar(r.nombre),
        codigo: r.codigo,
        region: r.region,
        usuario: r.usuario ? cifrar(r.usuario, config.cifrado.clave) : null,
        contrasena: r.contrasena ? cifrar(r.contrasena, config.cifrado.clave) : null,
        actualizadoEn: new Date(),
      },
      $setOnInsert: { creadoEn: new Date() },
    },
    { upsert: true }
  );
  existe ? actualizados++ : creados++;
}

console.log(`\nListo. Creados: ${creados}  |  actualizados: ${actualizados}`);
process.exit(0);
