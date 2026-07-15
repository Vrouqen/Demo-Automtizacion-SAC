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
  pin: ['pin', 'pin de acceso', 'codigo pin', 'pin asociado', 'pin estudiante'],
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

/**
 * Parsea un Excel de credenciales. Soporta archivos con pestañas
 * "Docentes" y/o "Estudiantes"; si no existen, usa la hoja activa
 * y la trata como estudiantes.
 */
export function parsearExcelCredenciales(buffer) {
  let libro;
  try {
    libro = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    const err = new Error('Archivo Excel inválido');
    err.statusCode = 400;
    throw err;
  }

  const resultado = { docentes: [], estudiantes: [], hojasProcesadas: [] };

  const nombresHojas = libro.SheetNames;
  const hojaDocentes = nombresHojas.find((n) => normalizar(n).includes('docente'));
  const hojaEstudiantes = nombresHojas.find(
    (n) => normalizar(n).includes('estudiante') || normalizar(n).includes('alumno')
  );

  if (hojaDocentes) {
    resultado.docentes = parsearHoja(libro.Sheets[hojaDocentes]);
    resultado.hojasProcesadas.push(hojaDocentes);
  }
  if (hojaEstudiantes) {
    resultado.estudiantes = parsearHoja(libro.Sheets[hojaEstudiantes]);
    resultado.hojasProcesadas.push(hojaEstudiantes);
  }

  // Sin pestañas reconocidas: usa la primera hoja como estudiantes
  if (!hojaDocentes && !hojaEstudiantes && nombresHojas.length > 0) {
    resultado.estudiantes = parsearHoja(libro.Sheets[nombresHojas[0]]);
    resultado.hojasProcesadas.push(nombresHojas[0]);
  }

  if (resultado.docentes.length === 0 && resultado.estudiantes.length === 0) {
    const err = new Error(
      'No se encontraron registros válidos. Verifica las pestañas "Docentes"/"Estudiantes" y las columnas (Grado, Grupo, Apellido Paterno, Apellido Materno, Nombre, Login, Contraseña).'
    );
    err.statusCode = 400;
    throw err;
  }

  return resultado;
}
