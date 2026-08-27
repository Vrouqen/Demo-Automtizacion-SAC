/**
 * Validación de documentos de identidad para el registro de consentimientos.
 *
 * El registro de consentimientos es prueba legal: si un dato entra mal, el
 * registro no sirve para demostrar nada. Por eso la cédula ecuatoriana se
 * verifica con su dígito comprobador y no solo por longitud.
 *
 * Se acepta también pasaporte o documento extranjero (la columna del registro
 * es "Cédula/ID"): no todos los representantes son ecuatorianos, y rechazar a
 * un extranjero sería peor que aceptar un documento que no podemos verificar.
 */

/** Coeficientes del algoritmo módulo 10 de la cédula ecuatoriana. */
const COEFICIENTES = [2, 1, 2, 1, 2, 1, 2, 1, 2];

/** Deja solo lo que puede ser un documento: dígitos y letras. */
export function normalizarDocumento(valor) {
  return String(valor ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/**
 * ¿Es una cédula ecuatoriana válida? Comprueba provincia, tipo de persona y
 * dígito verificador (módulo 10).
 */
export function esCedulaEcuatoriana(valor) {
  const doc = normalizarDocumento(valor);
  if (!/^\d{10}$/.test(doc)) return false;

  // Los dos primeros dígitos son la provincia: 01–24, más 30 para los
  // ecuatorianos registrados en el exterior.
  const provincia = Number(doc.slice(0, 2));
  if (!((provincia >= 1 && provincia <= 24) || provincia === 30)) return false;

  // El tercer dígito distingue el tipo: menor a 6 son personas naturales.
  if (Number(doc[2]) >= 6) return false;

  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let producto = Number(doc[i]) * COEFICIENTES[i];
    if (producto > 9) producto -= 9;
    suma += producto;
  }

  const verificador = (10 - (suma % 10)) % 10;
  return verificador === Number(doc[9]);
}

/**
 * Valida un documento para el registro. Devuelve `{ valor, tipo }` si sirve, o
 * `{ error }` con un mensaje que se le puede mostrar tal cual al usuario.
 *
 * Solo se comprueba la FORMA: diez dígitos para una cédula ecuatoriana.
 *
 * El dígito verificador (módulo 10) se comprobaba antes y se quitó a propósito:
 * rechazaba cédulas que las personas daban como suyas, y el correo entraba en un
 * bucle de "su cédula no es válida" del que no salían. Entre bloquear a alguien
 * con una cédula real y aceptar una mal tecleada, lo segundo hace menos daño: el
 * registro es prueba de lo que la persona declaró, no un padrón verificado.
 */
export function validarDocumento(valor) {
  const doc = normalizarDocumento(valor);

  if (!doc) return { error: 'no se indicó ningún número de documento' };

  if (/^\d{10}$/.test(doc)) return { valor: doc, tipo: 'cedula_ec' };

  // Solo dígitos pero sin llegar a diez: casi siempre es un número incompleto,
  // no un pasaporte, y conviene decirlo con claridad.
  if (/^\d+$/.test(doc)) {
    return { error: `${doc} tiene ${doc.length} dígitos; la cédula ecuatoriana tiene 10` };
  }

  if (doc.length < 5) return { error: `${doc} es demasiado corto para ser un documento de identidad` };

  return { valor: doc, tipo: 'pasaporte_u_otro' };
}
