// Alinea los colegios de SAC con el avance de Tablas-PAS (Luis, 2026-10-21).
//
// Los colegios se crearon a mano con un avance antiguo que tenía errores: ids
// de Pegasus equivocados, código e id intercambiados, nombres viejos y
// colegios duplicados (uno a mano, otro de la alimentación automática). Esto:
//   · deja cada colegio con el _id, código y nombre del avance;
//   · fusiona los documentos de un mismo colegio SIN perder estudiantes ni
//     docentes (solo se quita el repetido exacto: misma plataforma, periodo y
//     login; gana el que tenga contraseña);
//   · conserva región, ciudad y cantón reales y, si la región está en n/a, la
//     toma de adcol;
//   · no toca los colegios que no están en el avance o son ambiguos.
//
// Uso:
//   node scripts/alinear-con-avance.mjs avance.json            (simula)
//   node scripts/alinear-con-avance.mjs avance.json --aplicar  (respalda y aplica)
// avance.json: [{ciclo_codigo, colegio_id, id_uno, cod, nombre}] de
// bdc.colegio_cartera.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { readFileSync, writeFileSync } from 'node:fs';
import { descifrar } from '../src/utils/cifrado.js';
import { normalizar } from '../src/utils/similitud.js';

const [archivoAvance, ...opciones] = process.argv.slice(2);
const aplicar = opciones.includes('--aplicar');
const clave = process.env.CREDENCIALES_ENC_KEY;
const sinDato = (v) => v == null || ['', 'n/a'].includes(String(v).trim().toLowerCase());

const avance = JSON.parse(readFileSync(archivoAvance, 'utf8'));
const objetivo = new Map();            // _id final → fila del avance
const porCodigo = new Map();           // código → Set de _id finales
for (const a of avance) {
  const id = a.id_uno != null ? String(a.id_uno) : String(a.cod);
  if (!objetivo.has(id)) objetivo.set(id, a);
  if (a.cod) {
    if (!porCodigo.has(String(a.cod))) porCodigo.set(String(a.cod), new Set());
    porCodigo.get(String(a.cod)).add(id);
  }
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'sac');
const col = db.collection(process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios');
const adcol = new Map((await db.collection(process.env.MONGODB_COLLECTION_ADCOL || 'adcol')
  .find({}, { projection: { region: 1, codigo: 1 } }).toArray())
  .flatMap((d) => [[String(d._id), d.region], [String(d.codigo), d.region]]));

const docs = await col.find({}).toArray();

// ── A qué colegio del avance pertenece cada documento ─────────────────────
const destino = new Map();             // _id final → [docs]
const resumen = { porId: 0, intercambiados: 0, porCodigo: 0, fueraDelAvance: [], ambiguos: [] };
for (const d of docs) {
  const id = String(d._id);
  const cod = String(d.codigo ?? '');
  let final = null;
  if (objetivo.has(id)) { final = id; resumen.porId++; }
  else if (objetivo.has(cod) && String(objetivo.get(cod).cod ?? '') === id) { final = cod; resumen.intercambiados++; }
  else if (porCodigo.has(cod)) {
    const ids = porCodigo.get(cod);
    if (ids.size === 1) { final = [...ids][0]; resumen.porCodigo++; }
    else resumen.ambiguos.push(`${id} (${cod}) ${d.nombre}`);
  } else resumen.fueraDelAvance.push(`${id} (${cod}) ${d.nombre}`);
  if (final) {
    if (!destino.has(final)) destino.set(final, []);
    destino.get(final).push(d);
  }
}

// ── Fusión sin perder a nadie ─────────────────────────────────────────────
function fusionarPersonas(listas) {
  const salida = new Map();
  let entrada = 0;
  for (const lista of listas) {
    for (const r of lista || []) {
      entrada++;
      const login = normalizar(descifrar(r.login, clave) || '');
      const k = login ? `${r.plataforma}|${r.periodo}|${login}` : `sin-login|${salida.size}|${entrada}`;
      const previo = salida.get(k);
      const conClave = (x) => !!(x && descifrar(x.contrasena, clave));
      if (!previo || (!conClave(previo) && conClave(r))) salida.set(k, r);
    }
  }
  return { lista: [...salida.values()], entrada };
}

const cambios = [];
for (const [final, grupo] of destino) {
  const a = objetivo.get(final);
  // El documento base: el que ya tiene el _id final, si existe.
  grupo.sort((x, y) => (String(y._id) === final) - (String(x._id) === final));
  const base = grupo[0];
  const est = fusionarPersonas(grupo.map((g) => g.estudiantes));
  const doc = fusionarPersonas(grupo.map((g) => g.docentes));
  const primero = (campo) => grupo.map((g) => g[campo]).find((v) => !sinDato(v));
  const region = primero('region') ?? adcol.get(final) ?? adcol.get(String(a.cod)) ?? base.region ?? 'n/a';
  const ciudad = primero('ciudad') ?? primero('provincia') ?? base.ciudad ?? 'n/a';
  const canton = primero('canton') ?? base.canton ?? 'n/a';
  const codigo = String(a.cod ?? final);
  const nombre = a.nombre;

  const nuevo = {
    ...base,
    _id: final,
    codigo, nombre, nombreNormalizado: normalizar(nombre),
    region, regionNormalizada: normalizar(region),
    ciudad, ciudadNormalizada: normalizar(ciudad),
    provincia: ciudad, provinciaNormalizada: normalizar(ciudad),
    canton, cantonNormalizado: normalizar(canton),
    estudiantes: est.lista, docentes: doc.lista,
    actualizadoEn: new Date(),
  };

  const idsViejos = grupo.map((g) => String(g._id)).filter((id) => id !== final);
  const igual = idsViejos.length === 0 && base.codigo === codigo && base.nombre === nombre
    && base.region === region && base.ciudad === ciudad && base.canton === canton
    && est.lista.length === est.entrada && doc.lista.length === doc.entrada;
  if (igual) continue;

  cambios.push({
    final, idsViejos, nuevo,
    texto: `${final.padEnd(8)} ${String(base._id) !== final || idsViejos.length ? `[${grupo.map((g) => g._id).join('+')}] ` : ''}`
      + `${base.codigo !== codigo ? `cód ${base.codigo}→${codigo} ` : ''}`
      + `${base.nombre !== nombre ? `«${base.nombre}»→«${nombre}» ` : ''}`
      + `${base.region !== region ? `región ${base.region}→${region} ` : ''}`
      + `est ${est.entrada}→${est.lista.length}${doc.entrada ? ` doc ${doc.entrada}→${doc.lista.length}` : ''}`,
  });
}

console.log(`SAC: ${docs.length} colegios · por id ${resumen.porId} · id/código intercambiados ${resumen.intercambiados} · id corregido por código ${resumen.porCodigo}`);
console.log(`Fuera del avance (no se tocan): ${resumen.fueraDelAvance.length}`);
resumen.fueraDelAvance.forEach((t) => console.log('   ', t));
console.log(`Ambiguos (no se tocan): ${resumen.ambiguos.length}`);
resumen.ambiguos.forEach((t) => console.log('   ', t));
console.log(`Cambios: ${cambios.length}`);
cambios.forEach((c) => console.log('   ', c.texto));

if (!aplicar) {
  console.log('\nSimulación: no se cambió nada. Para aplicar: --aplicar');
} else {
  // Fuera del repo: lleva credenciales (cifradas). RESPALDO_DIR para elegir dónde.
  const respaldo = `${process.env.RESPALDO_DIR || '.'}/respaldo-colegios-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(respaldo, JSON.stringify(docs));
  console.log(`\nRespaldo completo (credenciales cifradas tal cual): ${respaldo}`);
  for (const c of cambios) {
    await col.replaceOne({ _id: c.final }, c.nuevo, { upsert: true });
    if (c.idsViejos.length) await col.deleteMany({ _id: { $in: c.idsViejos } });
  }
  console.log(`Aplicados ${cambios.length} cambios. Colegios ahora: ${await col.countDocuments()}`);
}
await client.close();
