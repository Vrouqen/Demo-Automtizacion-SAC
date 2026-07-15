import * as XLSX from 'xlsx';
import { normalizar } from '../utils/similitud.js';

// Mapeo flexible de encabezados: acepta variantes con/sin tildes, mayúsculas, etc.
const CAMPOS = {
  grado: ['grado', 'nivel'],
  grupo: ['grupo', 'paralelo', 'seccion'],
  apellidoPaterno: ['apellido paterno', 'ap paterno', 'apellido1', 'primer apellido'],
  apellidoMaterno: ['apellido materno', 'ap materno', 'apellido2', 'segundo apellido'],
  nombre: ['nombre', 'nombres'],
  login: ['login', 'usuario', 'user', 'username'],
  contrasena: ['contrasena', 'contraseña', 'password', 'clave', 'pass'],
};

function mapearEncabezados(filaEncabezados) {
  const mapa = {}; // indiceColumna -> nombreCampo
  filaEncabezados.forEach((celda, idx) => {
    const h = normalizar(celda);
    if (!h) return;
    for (const [campo, alias] of Object.entries(CAMPOS)) {
      if (alias.includes(h)) {
        mapa[idx] = campo;
        return;
      }
    }
  });
  return mapa;
}

function parsearHoja(hoja) {
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });
  if (filas.length === 0) return [];

  // Busca la fila de encabezados dentro de las primeras 5 filas
  let idxEncabezado = -1;
  let mapa = {};
  for (let i = 0; i < Math.min(filas.length, 5); i++) {
    const m = mapearEncabezados(filas[i] || []);
    // Mínimo requerimos login o (nombre + apellido)
    const campos = Object.values(m);
    if (campos.includes('login') || (campos.includes('nombre') && campos.includes('apellidoPaterno'))) {
      idxEncabezado = i;
      mapa = m;
      break;
    }
  }
  if (idxEncabezado === -1) return [];

  const registros = [];
  for (const fila of filas.slice(idxEncabezado + 1)) {
    if (!fila || fila.every((c) => c === null || String(c).trim() === '')) continue;
    const reg = {};
    for (const [idx, campo] of Object.entries(mapa)) {
      const valor = fila[Number(idx)];
      reg[campo] = valor === null || valor === undefined ? null : String(valor).trim();
    }
    const partesNombre = [reg.nombre, reg.apellidoPaterno, reg.apellidoMaterno].filter(Boolean);
    reg.nombreCompleto = partesNombre.join(' ');
    reg.nombreNormalizado = normalizar(reg.nombreCompleto);
    if (reg.nombreCompleto || reg.login) registros.push(reg);
  }
  return registros;
}

const esHojaDocentes = (n) => {
  const h = normalizar(n);
  return h.includes('docente') || h.includes('profesor') || h.includes('maestro');
};
const esHojaEstudiantes = (n) => {
  const h = normalizar(n);
  return h.includes('estudiante') || h.includes('alumno');
};

function error400(mensaje) {
  const err = new Error(mensaje);
  err.statusCode = 400;
  return err;
}

/**
 * Parsea un Excel de credenciales y devuelve ÚNICAMENTE estudiantes.
 *
 * El archivo suele traer dos pestañas ("Docentes" y "Estudiantes"): la de
 * docentes se ignora a propósito — el programa ya no gestiona sus credenciales.
 * Si no hay pestaña de estudiantes se usa la primera hoja que NO sea de
 * docentes; nunca se toma una hoja de docentes como respaldo, para no cargar
 * profesores como si fueran alumnos.
 */
export function parsearExcelCredenciales(buffer) {
  let libro;
  try {
    libro = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw error400('Archivo Excel inválido');
  }

  const nombresHojas = libro.SheetNames || [];
  if (nombresHojas.length === 0) throw error400('El archivo Excel no tiene hojas');

  const hojaEstudiantes = nombresHojas.find(esHojaEstudiantes);
  const hojaUsada = hojaEstudiantes || nombresHojas.find((n) => !esHojaDocentes(n));

  if (!hojaUsada) {
    throw error400(
      'El archivo solo contiene pestañas de Docentes. Se necesitan credenciales de estudiantes: ' +
        'incluye una pestaña "Estudiantes".'
    );
  }

  const estudiantes = parsearHoja(libro.Sheets[hojaUsada]);
  if (estudiantes.length === 0) {
    throw error400(
      `No se encontraron estudiantes válidos en la hoja "${hojaUsada}". Verifica las columnas ` +
        '(Grado, Grupo, Apellido Paterno, Apellido Materno, Nombre, Login, Contraseña).'
    );
  }

  return {
    estudiantes,
    hojasProcesadas: [hojaUsada],
    // Todo lo que quedó fuera (típicamente la pestaña de docentes), para poder
    // avisar al usuario qué se ignoró en vez de descartarlo en silencio.
    hojasIgnoradas: nombresHojas.filter((n) => n !== hojaUsada),
  };
}
