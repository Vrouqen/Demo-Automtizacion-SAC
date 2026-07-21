import 'dotenv/config';

export const config = {
  mongo: {
    uri: process.env.MONGODB_URI,
    db: process.env.MONGODB_DB || 'sac',
    coleccionColegios: process.env.MONGODB_COLLECTION_COLEGIOS || 'colegios',
    coleccionConversaciones: process.env.MONGODB_COLLECTION_CONVERSACIONES || 'conversaciones',
    coleccionEscalamientos: process.env.MONGODB_COLLECTION_ESCALAMIENTOS || 'escalamientos',
    coleccionDescartes: process.env.MONGODB_COLLECTION_DESCARTES || 'descartes',
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
  // La Function URL es pública (auth NONE). Si se define, el dashboard y el
  // reporte de analítica exigen ?token=... Deja vacío solo mientras pruebas:
  // aunque la analítica va agregada y no expone datos de estudiantes, sí revela
  // volúmenes del piloto y los correos de los agentes.
  dashboard: {
    token: process.env.DASHBOARD_TOKEN || '',
  },
  firma: {
    // Cómo se muestran los logos en la firma:
    //   'url' → <img src="https://.../?logo=..."> servido por esta misma Lambda
    //           (opción B: no toca n8n, requiere CEREBRO_URL).
    //   'cid' → adjuntos en línea; requiere que n8n los adjunte por Content-ID
    //           (opción A). 'true' se acepta como alias de 'cid' por compatibilidad.
    //   vacío → firma solo con texto, sin ninguna etiqueta <img>.
    logos: (() => {
      const v = (process.env.FIRMA_LOGOS || '').trim().toLowerCase();
      if (v === 'url') return 'url';
      if (v === 'cid' || v === 'true') return 'cid';
      return '';
    })(),
    // URL pública de esta Lambda (la Function URL), con o sin barra final. Sirve
    // para construir los <img src> cuando logos='url'. Sin ella, ese modo cae a
    // firma de solo texto (no queremos imágenes rotas).
    cerebroUrl: (process.env.CEREBRO_URL || '').trim().replace(/\/+$/, ''),
  },
  // Buzones de los equipos que atienden los tickets mientras Jira está en
  // standby. Si uno queda vacío, sus tickets se avisan a AGENTES_DIGITALES:
  // un ticket sin destinatario es un ticket que nadie atiende.
  equipos: {
    cuentas: (process.env.CORREO_EQUIPO_CUENTAS || '').trim(),
    servicioDigital: (process.env.CORREO_EQUIPO_SERVICIO_DIGITAL || '').trim(),
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
