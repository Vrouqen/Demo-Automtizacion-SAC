import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccionColegios: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
    coleccionConversaciones: process.env.MONGODB_COLLECTION_CONVERSACIONES || 'conversaciones',
    coleccionEscalamientos: process.env.MONGODB_COLLECTION_ESCALAMIENTOS || 'escalamientos',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    modelo: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // Si el modelo principal agota su cuota (429/RESOURCE_EXHAUSTED), se
    // reintenta la MISMA llamada con este modelo. En el tier gratuito cada
    // modelo tiene cuota diaria propia, así que esto duplica el presupuesto
    // efectivo del día. Vacío ('') para desactivar el respaldo.
    modeloFallback: process.env.GEMINI_MODEL_FALLBACK ?? 'gemini-3.5-flash',
  },
  // Clave AES-256 (32 bytes en base64) para descifrar las credenciales que
  // apps/carga-credenciales guardó cifradas. Debe ser LA MISMA en ambas apps.
  cifrado: {
    clave: process.env.CREDENCIALES_ENC_KEY,
  },
  // Correos de los agentes digitales de servicio (separados por coma).
  // Los casos escalados se asignan en round-robin sobre esta lista.
  agentes: {
    correos: (process.env.AGENTES_DIGITALES || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
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
  if (!config.cifrado.clave) faltantes.push('CREDENCIALES_ENC_KEY');
  if (config.agentes.correos.length === 0) faltantes.push('AGENTES_DIGITALES');
  if (faltantes.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(', ')}`);
  }
}
