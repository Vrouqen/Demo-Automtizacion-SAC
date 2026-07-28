import * as XLSX from 'xlsx';
import { normalizar } from '../utils/similitud.js';

// Mapeo flexible de encabezados: tolera variantes con/sin tildes, mayúsculas,
// español e inglés (RLP/RS vienen en inglés). Un mismo campo lógico admite
// varios alias.
const CAMPOS = {
  grado: ['grado', 'nivel', 'grade', 'level'],
  grupo: ['grupo', 'paralelo', 'seccion', 'class', 'clase', 'course'],
  // Apellidos: los archivos de estudiantes suelen separar paterno/materno; los
  // de docentes (y RLP/RS) traen un solo campo "Apellidos" / "Last Name".
  apellidoPaterno: ['apellido paterno', 'ap paterno', 'apellido1', 'primer apellido'],
  apellidoMaterno: ['apellido materno', 'ap materno', 'apellido2', 'segundo apellido'],
  apellidos: ['apellidos', 'apellido', 'last name', 'lastname', 'surname', 'apellido completo'],
  nombre: ['nombre', 'nombres', 'first name', 'firstname', 'given name'],
  login: ['login', 'usuario', 'user', 'username', 'user name'],
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

// Una hoja es "parseable" si tiene login/username y algún dato de nombre.
function encabezadoValido(campos) {
  return campos.includes('login') &&
    (campos.includes('nombre') || campos.includes('apellidos') || campos.includes('apellidoPaterno'));
}

function localizarEncabezado(filas) {
  for (let i = 0; i < Math.min(filas.length, 6); i++) {
    const m = mapearEncabezados(filas[i] || []);
    if (encabezadoValido(Object.values(m))) return { idx: i, mapa: m };
  }
  return null;
}

function parsearHoja(hoja) {
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });
  if (filas.length === 0) return { registros: [], campos: [] };

  const enc = localizarEncabezado(filas);
  if (!enc) return { registros: [], campos: [] };

  const { idx: idxEncabezado, mapa } = enc;
  const registros = [];
  for (const fila of filas.slice(idxEncabezado + 1)) {
    if (!fila || fila.every((c) => c === null || String(c).trim() === '')) continue;
    const reg = {};
    for (const [idx, campo] of Object.entries(mapa)) {
      const valor = fila[Number(idx)];
      reg[campo] = valor === null || valor === undefined ? null : String(valor).trim();
    }
    // Apellido combinado: paterno+materno separados, o el campo único "apellidos".
    const apellido = [reg.apellidoPaterno, reg.apellidoMaterno].filter(Boolean).join(' ') || reg.apellidos || '';
    reg.nombreCompleto = [reg.nombre, apellido].filter(Boolean).join(' ').trim();
    reg.nombreNormalizado = normalizar(reg.nombreCompleto);
    // El paralelo/grupo puede venir como "Class" en RLP/RS.
    if (!reg.grupo && reg.class) reg.grupo = reg.class;
    if (reg.nombreCompleto || reg.login) registros.push(reg);
  }
  return { registros, campos: Object.values(mapa) };
}

const REGLAS_ROL = [
  { rol: 'docentes', palabras: ['docente', 'profesor', 'maestro', 'teacher', 'staff'] },
  { rol: 'estudiantes', palabras: ['estudiante', 'alumno', 'student', 'pupil'] },
];

function rolPorNombreHoja(nombreHoja) {
  const h = normalizar(nombreHoja);
  for (const { rol, palabras } of REGLAS_ROL) {
    if (palabras.some((p) => h.includes(p))) return rol;
  }
  return null;
}

/**
 * Rol de una hoja SIN nombre revelador, deducido de sus columnas: si tiene
 * grado/grupo/paralelo (o "Class"), son estudiantes; si solo trae nombre + login
 * + contraseña, son docentes. Es la validación que pide el requerimiento cuando
 * mandan "una sola pestaña" sin decir de quién es.
 */
function rolPorColumnas(campos) {
  if (campos.includes('grado') || campos.includes('grupo')) return 'estudiantes';
  return 'docentes';
}

function error400(mensaje) {
  const err = new Error(mensaje);
  err.statusCode = 400;
  return err;
}

/**
 * Construye el paquete de datos para la carga de UN solo usuario (desde el
 * formulario individual, sin Excel). Devuelve exactamente la misma forma que
 * `parsearExcelCredenciales`, de modo que el resto del flujo —fusión con lo ya
 * guardado, cifrado y resumen— es idéntico y no hay un camino paralelo que
 * mantener.
 *
 * El nombre completo se arma aquí (no se confía en el cliente) para que la
 * búsqueda difusa del cerebro encuentre a esta persona igual que a las que
 * entraron por Excel.
 */
export function registroIndividual({ rol, nombres, apellidos, login, contrasena, nivel, paralelo }) {
  const nombre = String(nombres || '').trim();
  const apellido = String(apellidos || '').trim();
  const usuario = String(login || '').trim();
  const clave = String(contrasena || '').trim();

  if (!usuario) throw error400('Falta el login del usuario');
  if (!clave) throw error400('Falta la contraseña del usuario');
  if (!nombre && !apellido) throw error400('Indica al menos el nombre o el apellido del usuario');

  const esDocente = normalizar(rol) === 'docente';
  const nombreCompleto = [nombre, apellido].filter(Boolean).join(' ').trim();

  const reg = {
    nombre: nombre || null,
    apellidos: apellido || null,
    // Nivel y paralelo solo aplican a estudiantes.
    grado: esDocente ? null : String(nivel || '').trim() || null,
    grupo: esDocente ? null : String(paralelo || '').trim() || null,
    login: usuario,
    contrasena: clave,
    nombreCompleto,
    nombreNormalizado: normalizar(nombreCompleto),
  };

  return {
    estudiantes: esDocente ? [] : [reg],
    docentes: esDocente ? [reg] : [],
    hojasProcesadas: [{ hoja: 'carga individual', rol: esDocente ? 'docentes' : 'estudiantes', filas: 1 }],
    hojasIgnoradas: [],
  };
}

/**
 * Parsea un Excel de credenciales y devuelve estudiantes Y docentes.
 *
 * Reglas de asignación de cada hoja:
 *  1. Si el NOMBRE de la hoja dice de quién es (Estudiantes/Students,
 *     Docentes/Teachers), se respeta.
 *  2. Si no, se deduce por sus COLUMNAS (grado/grupo → estudiantes; solo
 *     nombre+login → docentes). Esto cubre el caso de "una sola pestaña".
 *
 * Devuelve las dos listas (cualquiera puede ir vacía), las hojas procesadas con
 * el rol asignado, y las que se ignoraron por no ser parseables.
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

  const estudiantes = [];
  const docentes = [];
  const hojasProcesadas = [];
  const hojasIgnoradas = [];

  for (const nombreHoja of nombresHojas) {
    const { registros, campos } = parsearHoja(libro.Sheets[nombreHoja]);
    if (registros.length === 0) {
      hojasIgnoradas.push(nombreHoja);
      continue;
    }
    const rol = rolPorNombreHoja(nombreHoja) || rolPorColumnas(campos);
    (rol === 'docentes' ? docentes : estudiantes).push(...registros);
    hojasProcesadas.push({ hoja: nombreHoja, rol, filas: registros.length });
  }

  if (estudiantes.length === 0 && docentes.length === 0) {
    throw error400(
      'No se encontraron credenciales válidas en el archivo. Revisa que haya una fila de ' +
        'encabezados con al menos Login/Usuario y el Nombre (o Apellidos).'
    );
  }

  return { estudiantes, docentes, hojasProcesadas, hojasIgnoradas };
}
