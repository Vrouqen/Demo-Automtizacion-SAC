import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccion: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
  },
  // Clave AES-256 (32 bytes en base64) para cifrar login/contraseña/PIN antes
  // de guardarlos en Mongo. Debe ser LA MISMA que usa apps/cerebro.
  cifrado: {
    clave: process.env.CREDENCIALES_ENC_KEY,
  },
  // Solo se aceptan cargas de credenciales de estas plataformas.
  plataformasPermitidas: ['compartir', 'creo'],
};

export function validarConfig() {
  const faltantes = [];
  if (!config.mongo.uri) faltantes.push('MONGODB_URI');
  if (!config.cifrado.clave) faltantes.push('CREDENCIALES_ENC_KEY');
  if (faltantes.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }
}
