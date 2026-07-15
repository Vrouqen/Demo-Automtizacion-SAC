import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Cifrado simétrico AES-256-GCM para credenciales en reposo (Mongo).
// El valor cifrado se guarda como string autocontenida: "enc.v1." + base64(iv | authTag | ciphertext).
// La clave viene de CREDENCIALES_ENC_KEY (32 bytes en base64) — misma clave en
// apps/carga-credenciales (cifra al subir) y apps/cerebro (descifra al consultar).

const PREFIJO = 'enc.v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function obtenerClave(claveBase64) {
  if (!claveBase64) {
    throw new Error(
      'Falta CREDENCIALES_ENC_KEY. Genera una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const clave = Buffer.from(claveBase64, 'base64');
  if (clave.length !== 32) {
    throw new Error('CREDENCIALES_ENC_KEY debe ser exactamente 32 bytes codificados en base64');
  }
  return clave;
}

export function estaCifrado(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIJO);
}

export function cifrar(texto, claveBase64) {
  if (texto === null || texto === undefined || texto === '') return texto;
  if (estaCifrado(texto)) return texto; // no cifrar dos veces
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', obtenerClave(claveBase64), iv);
  const cifrado = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  return PREFIJO + Buffer.concat([iv, cipher.getAuthTag(), cifrado]).toString('base64');
}

// Tolera valores en texto plano (datos cargados antes de activar el cifrado):
// si el valor no tiene el prefijo, se devuelve tal cual.
export function descifrar(valor, claveBase64) {
  if (!estaCifrado(valor)) return valor;
  const datos = Buffer.from(valor.slice(PREFIJO.length), 'base64');
  const iv = datos.subarray(0, IV_BYTES);
  const tag = datos.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const cifrado = datos.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', obtenerClave(claveBase64), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
}
