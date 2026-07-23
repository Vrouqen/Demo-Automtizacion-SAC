import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccion: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
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
  plataformasPermitidas: ['compartir', 'creo', 'sumun'],
  // Reconocidas por el parser pero no habilitadas todavía (para el mensaje de
  // error y para documentar que existen).
  plataformasEnEspera: ['rlp', 'rs'],
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
