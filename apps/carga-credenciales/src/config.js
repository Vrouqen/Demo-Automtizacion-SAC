import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccion: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
    coleccionAdcol: process.env.MONGODB_COLLECTION_ADCOL || 'adcol',
  },
  // Clave AES-256 (32 bytes en base64) para cifrar login/contraseña antes de
  // guardarlos en Mongo. Debe ser LA MISMA que usa apps/cerebro.
  cifrado: {
    clave: process.env.CREDENCIALES_ENC_KEY,
  },
  // Acceso al formulario web de carga. La contraseña NUNCA va en el código:
  // se configura como variable de entorno de la Lambda.
  acceso: {
    usuario: process.env.APP_USUARIO || 'sac_app',
    clave: process.env.APP_CLAVE,
  },
  // Plataformas cuya carga está ACTIVA. Sumun usa el mismo formato de archivo que
  // Compartir/CREO. RLP y RS están implementadas (parser en inglés, pestañas
  // Teachers/Students) pero DESACTIVADAS a propósito: la UI deshabilita sus
  // botones y el backend rechaza sus cargas hasta que se pasen a producción.
  // Práctica (Santillana Plus) entra solo por la alimentación automática de
  // Tablas-PAS (sac:sincronizar --plataforma=practica, 2026-10-21): login y
  // contraseña vienen de su API. No tiene botón en el formulario de carga.
  // 'compartir' y 'creo' siguen aceptándose SOLO para no romper cargas en
  // vuelo ni enlaces viejos: desde la unificación son la misma plataforma, EDI,
  // y la interfaz ya no ofrece ninguna de las dos. Lo que entre con ellas se
  // guarda tal cual; el script scripts/unificar-edi.mjs es quien las convierte.
  //
  // Una persona puede tener credenciales en VARIAS de estas a la vez: son
  // productos independientes y no se pisan entre sí. La fusión de cada carga
  // solo toca las filas de su misma plataforma y periodo (ver `esDeEstaCarga`
  // en handler.js), así que subir RLP no borra lo de EDI ni al revés.
  plataformasPermitidas: ['edi', 'compartir', 'creo', 'sumun', 'practica', 'rlp', 'rs'],
  // Ya no queda ninguna en espera: RLP y Richmond Studio se habilitaron a
  // petición del área (2026-11-11).
  plataformasEnEspera: [],
};

export function validarConfig() {
  const faltantes = [];
  if (!config.mongo.uri) faltantes.push('MONGODB_URI');
  if (!config.cifrado.clave) faltantes.push('CREDENCIALES_ENC_KEY');
  // Sin APP_CLAVE el formulario quedaría sin control de acceso: preferimos que
  // la función falle de forma visible antes que servir datos sin protección.
  if (!config.acceso.clave) faltantes.push('APP_CLAVE');
  if (faltantes.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }
}
