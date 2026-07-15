import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Sesión del formulario web: token firmado (HMAC-SHA256) con expiración.
//
// Por qué firmado y validado en el servidor: la Function URL es pública
// (Auth type NONE), así que un login solo en el navegador sería decorativo —
// bastaría con hacer POST directo al endpoint para saltárselo. El token se
// verifica en cada petición de datos.
//
// La clave de firma se deriva de CREDENCIALES_ENC_KEY (ya obligatoria) con una
// etiqueta de dominio, para no exigir otra variable de entorno más y para que
// firmar sesiones nunca use el mismo material que cifra credenciales.

const PREFIJO = 'sesion.v1.';
const DURACION_MS = 8 * 60 * 60 * 1000; // 8 horas: una jornada de trabajo

function claveFirma(claveBase64) {
  return createHash('sha256').update('sesion:' + String(claveBase64)).digest();
}

function firmar(payloadB64, claveBase64) {
  return createHmac('sha256', claveFirma(claveBase64)).update(payloadB64).digest('base64url');
}

/** Compara en tiempo constante; tolera longitudes distintas sin lanzar. */
export function igualSeguro(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function crearToken(usuario, claveBase64) {
  const payload = { u: usuario, exp: Date.now() + DURACION_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return PREFIJO + payloadB64 + '.' + firmar(payloadB64, claveBase64);
}

/** Devuelve el payload si el token es válido y no expiró; null en cualquier otro caso. */
export function verificarToken(token, claveBase64) {
  if (typeof token !== 'string' || !token.startsWith(PREFIJO)) return null;
  const resto = token.slice(PREFIJO.length);
  const corte = resto.lastIndexOf('.');
  if (corte === -1) return null;

  const payloadB64 = resto.slice(0, corte);
  const firma = resto.slice(corte + 1);
  if (!igualSeguro(firma, firmar(payloadB64, claveBase64))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extrae el token del header Authorization: Bearer <token>. */
export function tokenDeEvento(event) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}
