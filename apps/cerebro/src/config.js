import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccionColegios: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
    coleccionConversaciones: process.env.MONGODB_COLLECTION_CONVERSACIONES || 'conversaciones',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    modelo: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  jira: {
    habilitado: process.env.JIRA_HABILITADO === 'true',
    baseUrl: process.env.JIRA_BASE_URL || '',
    proyecto: process.env.JIRA_PROYECTO || '',
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
  },
};

export function validarConfig() {
  const faltantes = [];
  if (!config.mongo.uri) faltantes.push('MONGODB_URI');
  if (!config.gemini.apiKey) faltantes.push('GEMINI_API_KEY');
  if (faltantes.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }
}
