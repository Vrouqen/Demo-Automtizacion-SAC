import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccion: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
  },
};

export function validarConfig() {
  if (!config.mongo.uri) {
    throw new Error('Falta configurar MONGODB_URI');
  }
}
