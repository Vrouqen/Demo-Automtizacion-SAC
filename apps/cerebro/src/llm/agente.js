import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { buscarEstudiante, buscarColegio, contarEstudiantesActivos } from '../services/busqueda.js';
import { crearTicket } from '../services/tickets.js';
import { crearEscalamiento } from '../services/escalamientos.js';
import {
  obtenerOCrearConversacion,
  registrarMensaje,
  registrarEvento,
  actualizarEstado,
  registrarDescarte,
} from '../services/conversaciones.js';
import { coleccionConversaciones } from '../db/mongo.js';
import { limpiarCuerpoCorreo, textoAHtml } from '../utils/correo.js';
import { conFirmaTexto } from '../utils/firma.js';
import { clasificarCorreoBasura } from '../utils/clasificacion.js';

const MAX_ITERACIONES_TOOLS = 6;

// Estados de buscar_credenciales en los que el asistente PIDE algo al usuario y
// queda a la espera de su respuesta (candidatos al cierre automático por 24h).
const ESTADOS_ESPERANDO_USUARIO = new Set([
  'HOMONIMOS',
  'COLEGIO_NO_ENCONTRADO',
  'ESTUDIANTE_NO_ENCONTRADO',
  'CANDIDATOS',
]);

/**
 * Llama a Gemini envolviendo los errores del proveedor para poder distinguir
 * "se acabó la cuota / rate limit" del resto (y no responderle basura al usuario).
 */
async function generarContenido(ai, params) {
  try {
    return await ai.models.generateContent(params);
  } catch (err) {
    const msg = String(err?.message || err || '');
    const status = err?.status ?? err?.code ?? err?.response?.status;
    const wrapped = new Error(msg);
    wrapped.esErrorLLM = true;
    wrapped.esCuota =
      status === 429 ||
      status === 'RESOURCE_EXHAUSTED' ||
      /quota|resource[_\s-]?exhausted|rate.?limit|too many requests|\b429\b/i.test(msg);
    throw wrapped;
  }
}

/**
 * Igual que generarContenido, pero con respaldo de cuota: si el modelo
 * principal devuelve 429/RESOURCE_EXHAUSTED y hay un modelo de respaldo
 * configurado, reintenta la misma llamada con él (cada modelo del tier
 * gratuito tiene cuota diaria propia). Solo si ambos fallan se propaga el
 * error para que el handler devuelva 503 y n8n reintente después.
 */
async function generarConRespaldo(ai, params) {
  try {
    return await generarContenido(ai, { ...params, model: config.gemini.modelo });
  } catch (err) {
    const fallback = config.gemini.modeloFallback;
    if (err.esErrorLLM && err.esCuota && fallback && fallback !== config.gemini.modelo) {
      return generarContenido(ai, { ...params, model: fallback });
    }
    throw err;
  }
}

const TOOLS = [
  {
    name: 'buscar_credenciales',
    description:
      'Busca las credenciales (login y contraseña) de un estudiante. Usa coincidencia difusa: ' +
      'tolera nombres incompletos en la base de datos (ej. solo un nombre y un apellido) y nombres ' +
      'de colegio escritos de forma aproximada. La ciudad (provincia) y el cantón ayudan a ' +
      'distinguir colegios homónimos. Llama a esta herramienta en cuanto tengas al menos ' +
      'el nombre del estudiante y el colegio; usa "n/a" en los datos de ubicación que no tengas.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        nombre_completo: { type: 'string', description: 'Nombre completo del estudiante' },
        nivel: { type: 'string', description: 'Nivel o grado del estudiante (si se conoce)' },
        paralelo: { type: 'string', description: 'Paralelo o grupo (si se conoce)' },
        colegio: {
          type: 'string',
          description: 'Nombre de la unidad educativa (el oficial o cualquier nombre alternativo que dé el usuario)',
        },
        region: { type: 'string', description: 'Región del colegio (Costa, Sierra, Oriente, Insular); "n/a" si no se conoce' },
        ciudad: { type: 'string', description: 'Ciudad (provincia) del colegio; "n/a" si no se conoce' },
        canton: { type: 'string', description: 'Cantón del colegio; "n/a" si no se conoce' },
      },
      required: ['nombre_completo', 'colegio'],
    },
  },
  {
    name: 'derivar_a_agente_digital',
    description:
      'Deriva el caso a una persona (agente digital de servicio). Úsala cuando: (a) el colegio no se ' +
      'encuentra después de haber pedido al usuario otro nombre de la institución y esa búsqueda también ' +
      'falló (o dijo no conocer otro nombre); (b) el estudiante no se encuentra después de que el usuario ' +
      'verificó/corrigió los datos y la nueva búsqueda también falló; (c) la consulta es sobre Santillana ' +
      'pero no corresponde a ninguna de tus funciones. NO la uses en el primer intento fallido de una búsqueda.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          enum: ['colegio_no_encontrado', 'estudiante_no_encontrado', 'otro'],
          description: 'Motivo del escalamiento',
        },
        resumen_corto: {
          type: 'string',
          description:
            'Resumen de UNA línea (máximo 70 caracteres) para el asunto del correo del agente. ' +
            'Ej: "Credenciales de Juan Pérez — U.E. San Francisco (Quito)".',
        },
        descripcion_detallada: {
          type: 'string',
          description:
            'Descripción COMPLETA de lo que necesita el usuario, con el detalle que él mismo dio: ' +
            'qué solicita exactamente, para qué lo necesita, qué problema tiene y desde cuándo. ' +
            'No resumas en una frase genérica; el agente humano debe poder atender el caso sin ' +
            'volver a preguntarle nada al usuario.',
        },
        datos_estudiante: {
          type: 'string',
          description:
            'Nombre completo, nivel y paralelo del estudiante. Escribe "no proporcionado" en los ' +
            'datos que el usuario no haya dado.',
        },
        datos_institucion: {
          type: 'string',
          description:
            'TODOS los nombres de la institución que se intentaron (incluidos los alternativos que ' +
            'dio el usuario), más ciudad (provincia) y cantón.',
        },
        intentos_previos: {
          type: 'string',
          description:
            'Qué búsquedas hiciste y por qué fallaron, y qué le preguntaste al usuario. Sirve para ' +
            'que el agente no repita lo ya intentado.',
        },
        usuario_confirmo_sin_datos: {
          type: 'boolean',
          description:
            'true SOLO si ya le pediste los datos que faltan y el usuario respondió explícitamente ' +
            'que no los tiene o no los conoce. Nunca lo pongas en true para saltarte el paso de preguntar.',
        },
      },
      required: [
        'motivo',
        'resumen_corto',
        'descripcion_detallada',
        'datos_estudiante',
        'datos_institucion',
        'intentos_previos',
      ],
    },
  },
  {
    name: 'consultar_estudiantes_activos',
    description:
      'Consulta cuántos estudiantes ACTIVOS tiene un colegio de Ecuador (un estudiante está activo ' +
      'cuando tiene credenciales de acceso cargadas). Acepta el id del colegio en Pegasus o el nombre del colegio.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        id_colegio: { type: 'string', description: 'Id del colegio en Pegasus (si se conoce)' },
        colegio: { type: 'string', description: 'Nombre del colegio (si no se tiene el id)' },
        ciudad: { type: 'string', description: 'Ciudad (provincia), para desambiguar homónimos' },
        canton: { type: 'string', description: 'Cantón, para desambiguar homónimos' },
      },
      required: [],
    },
  },
  {
    name: 'crear_ticket',
    description:
      'Crea un ticket de soporte. Úsala SIEMPRE para reseteos de contraseña (tipo reset_password, ' +
      'equipo cuentas) y para incidencias de plataforma como "no veo contenido" o "no veo mis clases" ' +
      '(tipo incidencia_plataforma, equipo servicio_digital). El equipo que atiende el ticket NO puede ' +
      'ver esta conversación: necesita saber A QUIÉN afecta y DE QUÉ institución es. No la llames si ' +
      'aún no tienes esos datos: pídelos primero al usuario.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['reset_password', 'incidencia_plataforma'] },
        equipo: { type: 'string', enum: ['cuentas', 'servicio_digital'] },
        nombre_estudiante: { type: 'string', description: 'Nombre completo del estudiante. Obligatorio.' },
        institucion: { type: 'string', description: 'Unidad educativa (colegio). Obligatorio.' },
        ciudad: { type: 'string', description: 'Ciudad (provincia) de la institución. Obligatorio.' },
        canton: {
          type: 'string',
          description:
            'Cantón de la institución. OPCIONAL: solo pídelo si la búsqueda del colegio falló o ' +
            'devolvió homónimos. Déjalo vacío si no hizo falta.',
        },
        nivel: { type: 'string', description: 'Nivel o grado del estudiante. Obligatorio.' },
        paralelo: { type: 'string', description: 'Paralelo o grupo del estudiante. Obligatorio.' },
        descripcion: {
          type: 'string',
          description:
            'Detalle minucioso del problema con las palabras del usuario: qué le pasa, desde cuándo, ' +
            'qué mensaje de error ve, en qué plataforma (Compartir/CREO) y qué intentó. ' +
            'Obligatorio para incidencia_plataforma.',
        },
        plataforma: {
          type: 'string',
          description: 'Plataforma afectada (Compartir, CREO u otra) si el usuario la indicó.',
        },
      },
      required: ['tipo', 'equipo', 'nombre_estudiante', 'institucion', 'ciudad', 'nivel', 'paralelo'],
    },
  },
  {
    name: 'info_pin',
    description:
      'Devuelve un mini tutorial de dónde encontrar el PIN de acceso del libro de "Compartir". ' +
      'Úsala para CUALQUIER consulta sobre el PIN.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        pin_no_funciona: {
          type: 'boolean',
          description: 'true si el usuario reporta que el PIN no funciona; false si solo pregunta dónde encontrarlo',
        },
      },
      required: ['pin_no_funciona'],
    },
  },
  {
    name: 'fuera_de_alcance',
    description:
      'Regístralo cuando la consulta no corresponde a ninguna de las funciones de soporte de Santillana.',
    parametersJsonSchema: { type: 'object', properties: {}, required: [] },
  },
];

const SYSTEM_PROMPT = `Eres el asistente de soporte de Santillana Ecuador. Atiendes solicitudes que llegan
por correo electrónico a las cuentas de soporte de Ecuador. Respondes SIEMPRE en español, en tono
profesional y cordial, apropiado para un correo de soporte (puedes ser un poco más extenso que en un
chat, pero ve al punto).

## 0. LA LISTA DE DATOS (vale para credenciales, reseteos e incidencias)
Cuando tengas que pedir datos del estudiante, pídelos SIEMPRE con estas etiquetas y EN ESTE ORDEN,
saltándote los que ya te haya dado:
- Nombre completo del estudiante
- Unidad educativa (colegio)
- Ciudad (provincia)
- Nivel
- Paralelo
En una incidencia de plataforma, añade al final:
- Detalle minucioso del problema

EL CANTÓN NO SE PIDE DE ENTRADA. Nunca lo incluyas en esa lista. Solo lo pides DESPUÉS, en un
correo aparte, y únicamente si la búsqueda del colegio devolvió HOMONIMOS o COLEGIO_NO_ENCONTRADO —
que es lo único para lo que sirve: desempatar entre colegios. Pedirlo por adelantado a todo el
mundo alarga cada conversación para resolver unos pocos casos. Si el usuario lo da por su cuenta,
úsalo.

## 1. Obtener credenciales de un estudiante
Datos necesarios ANTES de buscar: los del punto 0.
- REGLA CENTRAL: si falta alguno, NO llames todavía a buscar_credenciales. Tu respuesta debe pedir
  TODOS los que falten, en una sola lista con guiones (no de uno en uno), y quedar a la espera del
  correo del usuario.
- Este es un flujo ITERATIVO: cada vez que el usuario responda, revisa qué datos ya tienes en la
  conversación y cuáles siguen faltando; si aún falta algo, vuelve a pedir SOLO lo que falta.
- Si el usuario dice explícitamente que no conoce un dato (ej. no sabe el paralelo), acéptalo, no
  insistas con ese dato, y trátalo como "n/a".
- Solo cuando tengas todos los datos (o el usuario haya dicho que no los tiene), llama a
  buscar_credenciales, con "n/a" en el cantón si no lo tienes.
Interpreta el resultado:
- OK: entrega login y contraseña con claridad (indica también la plataforma: Compartir o CREO).
- HOMONIMOS: hay dos o más colegios con nombre igual o muy parecido. Muestra las opciones con su
  ciudad (provincia) y cantón, y pide al usuario confirmar cuál corresponde. NUNCA elijas uno al azar.
- COLEGIO_NO_ENCONTRADO: sigue este flujo EN ORDEN, sin saltarte pasos:
  1. Si hay "sugerencias", muéstralas (nombre + ciudad + cantón) para que el remitente confirme.
  2. Si no hay sugerencias útiles (o el usuario ya las descartó), pregunta si conoce la institución
     por ALGÚN OTRO NOMBRE (nombre comercial, nombre anterior, siglas, etc.).
  3. Si el usuario da otro nombre, vuelve a buscar con ese nombre.
  4. SOLO si el usuario dice que no conoce otro nombre, o si la búsqueda con el nombre alternativo
     también falla, usa derivar_a_agente_digital (motivo colegio_no_encontrado) con un resumen
     completo del caso.
- ESTUDIANTE_NO_ENCONTRADO: pide al usuario verificar la escritura del nombre completo, el nivel y
  el paralelo. Si el usuario confirma o corrige los datos y una nueva búsqueda también falla, NO lo
  dejes sin salida: usa derivar_a_agente_digital (motivo estudiante_no_encontrado) con el resumen
  completo, para que una persona lo resuelva.
- CANDIDATOS: el nombre en la base puede estar incompleto (ej. un nombre y un apellido). Muestra los
  candidatos (nombre, grado, grupo) y pide confirmar cuál corresponde, o el dato que falta.
- SIN_COLEGIOS: informa que aún no hay colegios cargados en el sistema.

## 1b. Derivación a un agente digital de servicio
Cuando derivas, una PERSONA va a atender el caso leyendo únicamente el correo que genera la
herramienta. Esa persona no puede ver esta conversación. Por eso, antes de derivar, tu trabajo es
dejar el caso completamente documentado.

PASO OBLIGATORIO ANTES DE DERIVAR: nunca derives en el PRIMER correo del usuario si no te dio ya
todos los datos. Si no tienes una descripción detallada del problema, pídela y ESPERA la respuesta
del usuario. No derives con una descripción genérica tipo "pide credenciales" o "tiene un problema",
ni con los campos en "no proporcionado": el sistema rechaza esas derivaciones y devuelve
FALTA_INFORMACION con la lista de datos que debes pedir. Pide, en una sola lista con guiones, lo que
falte de:
- Qué necesita exactamente y para qué (con sus propias palabras)
- Desde cuándo tiene el problema y qué mensaje de error ve, si aplica
- Nombre completo del estudiante, nivel y paralelo
- Nombre de la institución (y cualquier otro nombre con el que se la conozca), ciudad y cantón
- Si ya intentó algo por su cuenta

Deriva solo cuando tengas esa información, o cuando el usuario haya dicho explícitamente que no la
tiene o no la conoce (en ese caso, y solo en ese, usa usuario_confirmo_sin_datos=true). Al llamar a
derivar_a_agente_digital, llena TODOS los campos con el mayor detalle posible: descripcion_detallada
debe permitir que el agente entienda y resuelva el caso sin volver a escribirle al usuario.

Cuando uses derivar_a_agente_digital, la herramienta asigna el caso a una persona del equipo y
devuelve un código de caso. En tu respuesta al usuario: informa que su caso será atendido por un
agente digital de servicio, menciona el código del caso, y explica que la respuesta le llegará a este
mismo hilo de correo. No prometas tiempos exactos de respuesta.

## 1c. Estudiantes activos de un colegio
Si preguntan cuántos estudiantes activos tiene un colegio (un estudiante está activo cuando tiene sus
credenciales de acceso cargadas), usa consultar_estudiantes_activos (con el id de Pegasus si lo dan, o
con el nombre del colegio). Reporta el total, los activos y el desglose por plataforma si existe. Si
devuelve HOMONIMOS, pide ciudad/cantón para confirmar el colegio.

## 2. Reseteo de contraseña
El reseteo lo ejecuta el equipo de Cuentas, que atiende leyendo SOLO el ticket: no ve este correo ni
esta conversación. Por eso, ANTES de crear el ticket necesitas los datos del punto 0 (nombre, colegio,
ciudad, nivel, paralelo). Si falta alguno, NO llames a crear_ticket todavía: pídelos en una sola lista
con guiones, en el orden del punto 0, y espera la respuesta. Un correo como "no me acuerdo la
contraseña de mi hijo" no alcanza para abrir un ticket: no dice de qué estudiante ni de qué colegio se
trata.

Cuando tengas los datos, SIEMPRE genera el ticket (crear_ticket, tipo "reset_password", equipo
"cuentas"). No intentes resolverlo tú mismo ni inventes una contraseña nueva. Recién entonces informa
que se generó el ticket, con su código real, y que la respuesta llegará a este mismo correo.

## 3. PIN de acceso
Cualquier consulta sobre el PIN se responde con el mini tutorial que devuelve info_pin: explica al
usuario, paso a paso, dónde encontrarlo (está impreso en el reverso del libro de "Compartir").
Preséntalo como una lista numerada de pasos. Usa pin_no_funciona=false si solo preguntan dónde está,
y pin_no_funciona=true si reportan que no les funciona (en ese caso agrega la nota que devuelve la
herramienta). No inventes otros pasos ni prometas validar el PIN: no hay forma automática de hacerlo.

## 4. Incidencias de plataforma
Si reportan que no ven contenido, no ven sus clases, o algo similar, usa crear_ticket (tipo
"incidencia_plataforma", equipo "servicio_digital"). Necesitas los datos del punto 0 MÁS el detalle
minucioso del problema: qué no puede ver o hacer, desde cuándo, qué mensaje de error aparece y en qué
plataforma (Compartir o CREO). Si falta algo, pídelo primero en una lista con guiones, en ese orden.
Menciona si hay adjuntos relevantes.

## 4b. Cuando el sistema devuelve FALTA_INFORMACION
Significa que la acción NO se ejecutó porque faltan datos. No hay ticket ni caso: no los menciones,
no inventes códigos y no digas que ya se gestionó. Limítate a pedirle al usuario, en una lista con
guiones, exactamente los datos que vienen en el campo "faltan".

## 5. Otros temas
- Si la consulta SÍ tiene que ver con Santillana (sus libros, plataformas o servicios) pero no calza
  en ninguna de las funciones anteriores, NO la rechaces: usa derivar_a_agente_digital (motivo
  "otro") con un resumen claro de lo que pide el usuario, para que una persona del equipo la atienda.
- Si la consulta NO tiene ninguna relación con Santillana, DEBES llamar a la herramienta
  fuera_de_alcance. Es OBLIGATORIO llamarla: nunca escribas tú mismo una respuesta de rechazo, porque
  la herramienta genera el texto correcto (indica los temas que sí se atienden). No respondas ese
  tipo de correo sin haber llamado antes a fuera_de_alcance.
- PROHIBIDO en cualquier caso: decir "no puedo ayudarte", "no brindamos apoyo con eso", "está fuera
  del alcance" o frases equivalentes de rechazo escritas por ti. Siempre ofrece un camino: qué temas
  sí atiende este correo, o la derivación a una persona.

## Formato de tus correos
- Saludo breve en la primera línea (ej. "Estimado/a:" o "Hola, gracias por escribirnos.").
- Párrafos cortos (máximo 2-3 líneas) separados por UNA línea en blanco.
- Cuando pidas o enumeres varios datos, usa una lista con guiones (-), un dato por línea.
- Para instrucciones paso a paso, usa lista numerada (1., 2., 3.).
- Nunca escribas un solo bloque largo de texto sin saltos de línea.
- No uses formato Markdown (nada de **asteriscos**, # ni tablas): es un correo de texto con saltos
  de línea.

## Recolección de datos entre correos (NO repreguntes lo que ya te dieron)
Antes de pedir cualquier dato, RELEE toda la conversación y arma mentalmente la lista de lo que el
usuario ya te entregó, sin importar en qué correo lo escribió ni con qué palabras. Solo pregunta por
lo que falta de verdad.
- Repetir una pregunta que el usuario ya contestó es el peor error posible: lo hace sentir que no lo
  leíste y lo hace abandonar el caso.
- Un dato entregado sigue siendo válido para siempre en ese hilo. Si el usuario respondió con una
  lista, léela COMPLETA hasta la última línea antes de decidir qué falta.
- Si el usuario contestó a medias, agradece lo que sí dio, dilo explícitamente ("ya tenemos el nombre
  y la institución") y pide solo lo restante.
- Un dato parcial cuenta: si dio la provincia pero no el cantón, pide únicamente el cantón, no toda
  la ubicación otra vez.
- Si un correo del usuario llega cortado a mitad de una frase, no supongas que ese dato falta:
  pídele que reenvíe esa parte.

## Reglas generales
- NUNCA prometas una acción sin haber llamado a la herramienta que la ejecuta. Si vas a decir que el
  caso se deriva a un agente digital, primero llama a derivar_a_agente_digital; si vas a decir que se
  generó un ticket, primero llama a crear_ticket. Escribir "hemos generado el caso" sin haber llamado
  la herramienta es un error grave: el caso no existiría.
- NUNCA escribas un código de caso o de ticket inventado, ni un marcador de posición como
  "[código del caso]". Los códigos reales los devuelve la herramienta; si no llamaste a la
  herramienta, no menciones ningún código.
- No inventes datos: solo entrega credenciales que devuelva la herramienta.
- No muestres datos de un estudiante distinto al que el usuario pidió.
- Sé preciso sobre por qué falló una búsqueda (colegio no encontrado vs estudiante no encontrado).
- El historial de la conversación puede incluir tus propios correos anteriores (rol model): NO los
  repitas ni respondas a ellos; responde únicamente al último correo del usuario.
- NO escribas despedida ni firma al final ("Saludos cordiales", "Soporte Santillana Ecuador",
  datos de contacto): el sistema pega la firma corporativa automaticamente. Termina tu correo
  con la ultima frase util.`;

// ---------------------------------------------------------------------------
// Puerta de datos mínimos
//
// El prompt le pide al modelo que recopile información antes de crear un ticket
// o derivar el caso, pero un prompt no es una garantía: el modelo se saltaba el
// paso y derivaba/prometía tickets con "no proporcionado" en todos los campos,
// dejando al agente humano sin nada con que trabajar. Estas validaciones son la
// garantía dura: si faltan datos, la herramienta NO se ejecuta y se devuelve
// FALTA_INFORMACION con la lista exacta de lo que hay que preguntar.
// ---------------------------------------------------------------------------

// "no proporcionado", "n/a", "se desconoce"... son relleno, no datos.
const RE_PLACEHOLDER =
  /^(n\s*\/?\s*a|nd|ninguno|ninguna|no aplica|desconocid[oa]s?|se desconoce|sin datos?|sin especificar|sin informaci[óo]n|pendiente|por definir|no (?:lo )?(?:s[ée]|sabe|sabemos|conoce|indic[óo]|especific[óo]|menciona|proporcion[óo])|no (?:proporcionad|indicad|especificad|suministrad|brindad|dad)[oa]s?)\b/i;

/**
 * Devuelve el valor si es un dato real; null si viene vacío o es un relleno.
 *
 * Un solo carácter cuenta siempre que sea alfanumérico: los paralelos son
 * literalmente "A", "B", y los niveles pueden ser "5". Lo que se descarta de un
 * carácter es la puntuación suelta ("-", ".", "?") con la que el modelo rellena
 * un campo que en realidad no tiene.
 */
function dato(valor) {
  const t = String(valor ?? '').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return null;
  if (t.length === 1 && !/[a-z0-9áéíóúñ]/i.test(t)) return null;
  if (RE_PLACEHOLDER.test(t)) return null;
  return t;
}

function faltaInformacion(faltan, instruccion) {
  return { status: 'FALTA_INFORMACION', faltan, instruccion };
}

// Orden EXACTO en el que se le piden los datos al usuario. Es el mismo en los
// tres flujos (credenciales, reseteo, incidencia) para que quien atiende varios
// correos seguidos vea siempre la misma lista, y está definido una sola vez para
// que el prompt y la validación no puedan desincronizarse.
//
// El cantón NO está en la lista: la mayoría de la gente no lo sabe de memoria y
// pedirlo de entrada añade fricción a todos los casos para resolver unos pocos.
// Solo se pide cuando la búsqueda del colegio falla o devuelve homónimos, que es
// justo cuando sirve para desempatar.
export const DATOS_ESTUDIANTE = [
  ['nombre_estudiante', 'Nombre completo del estudiante'],
  ['institucion', 'Unidad educativa (colegio)'],
  ['ciudad', 'Ciudad (provincia)'],
  ['nivel', 'Nivel'],
  ['paralelo', 'Paralelo'],
];

export const PEDIR_CANTON = 'Cantón de la institución';
export const PEDIR_DETALLE = 'Detalle minucioso del problema: qué ocurre, desde cuándo, qué mensaje de error aparece y en qué plataforma (Compartir o CREO)';

/**
 * ¿Se puede crear el ticket con lo que hay? El equipo de Cuentas / Servicio
 * Digital atiende leyendo SOLO el ticket —no ve el hilo de correo—, así que un
 * ticket sin estudiante ni institución es inservible y acaba rebotando al
 * usuario con las mismas preguntas.
 */
export function validarDatosTicket(args) {
  const faltan = DATOS_ESTUDIANTE.filter(([campo]) => !dato(args[campo])).map(([, etiqueta]) => etiqueta);

  // El detalle solo se exige en incidencias: en un reseteo de contraseña el
  // problema ya está dicho con el propio asunto.
  if (args.tipo === 'incidencia_plataforma') {
    const desc = dato(args.descripcion);
    if (!desc || desc.length < 40) faltan.push(PEDIR_DETALLE);
  }

  if (faltan.length === 0) return null;
  return faltaInformacion(
    faltan,
    'NO se creó el ticket porque faltan datos que el equipo necesita. Pide al usuario, en una sola ' +
      'lista con guiones y EN ESTE MISMO ORDEN, los datos listados en "faltan". No pidas el cantón. ' +
      'No prometas ni menciones ningún ticket: todavía no existe.'
  );
}

/**
 * ¿Se puede derivar el caso a una persona? Regla central: no se deriva sin
 * haber preguntado antes. En el PRIMER correo del hilo solo se permite derivar
 * si el usuario ya escribió un caso completo por su cuenta.
 */
export function validarDatosDerivacion(args, { turnosUsuario = 1 } = {}) {
  const primerContacto = turnosUsuario <= 1;
  const yaPreguntamos = Boolean(args.usuario_confirmo_sin_datos) && !primerContacto;
  if (yaPreguntamos) return null; // el usuario dijo que no tiene más datos: se deriva igual

  const faltan = [];
  const desc = dato(args.descripcion_detallada);
  const minimoDescripcion = primerContacto ? 120 : 60;
  if (!desc || desc.length < minimoDescripcion) {
    faltan.push('Qué necesita exactamente y para qué, con sus propias palabras');
    faltan.push('Desde cuándo tiene el problema y qué mensaje de error ve, si aplica');
  }
  if (args.motivo !== 'otro' || dato(args.datos_estudiante) || dato(args.datos_institucion)) {
    if (!dato(args.datos_estudiante)) {
      faltan.push('Nombre completo del estudiante, nivel y paralelo');
    }
    if (!dato(args.datos_institucion)) {
      faltan.push('Nombre de la institución educativa (y cualquier otro nombre con el que se la conozca), ciudad y cantón');
    }
  }

  if (faltan.length === 0) return null;
  return faltaInformacion(
    [...new Set(faltan)],
    'NO se derivó el caso. Una persona va a atenderlo leyendo solo el correo de derivación, así que ' +
      'primero hay que recopilar la información. Pide al usuario, en una sola lista con guiones, los ' +
      'datos listados en "faltan" y ESPERA su respuesta. No menciones derivación, agente digital ni ' +
      'código de caso: todavía no existe. Cuando el usuario responda (o diga que no tiene esos datos), ' +
      'vuelve a llamar a derivar_a_agente_digital con todo el detalle.'
  );
}

async function ejecutarTool(nombre, args, contexto) {
  try {
    switch (nombre) {
      case 'buscar_credenciales': {
        const resultado = await buscarEstudiante({
          nombreCompleto: args.nombre_completo,
          nivel: args.nivel,
          paralelo: args.paralelo,
          colegio: args.colegio,
          region: args.region || 'n/a',
          ciudad: args.ciudad || 'n/a',
          canton: args.canton || 'n/a',
        });
        await registrarEvento(contexto.hiloId, {
          tipo: `credencial_${String(resultado.status).toLowerCase()}`,
          detalle: { colegio: args.colegio, nombre: args.nombre_completo },
        });
        // Si la búsqueda no fue directa (homónimos, colegio/estudiante no
        // encontrado, candidatos), el asistente le pedirá algo al usuario y
        // queda esperando su respuesta. Un OK se considera resuelto.
        contexto.esperandoInfoUsuario = ESTADOS_ESPERANDO_USUARIO.has(String(resultado.status));
        return resultado;
      }
      case 'derivar_a_agente_digital': {
        const faltan = validarDatosDerivacion(args, { turnosUsuario: contexto.turnosUsuario });
        if (faltan) {
          await registrarEvento(contexto.hiloId, {
            tipo: 'derivacion_bloqueada_falta_info',
            detalle: { motivo: args.motivo, faltan: faltan.faltan },
          });
          contexto.esperandoInfoUsuario = true;
          return faltan;
        }
        // Si la creación del caso falla (p. ej. AGENTES_DIGITALES sin configurar
        // o Mongo caído), NO se puede seguir: el modelo respondería "un agente
        // le atenderá" y el caso no existiría ni le llegaría a nadie. Se marca
        // como error crítico para abortar toda la respuesta (ver procesarCorreo).
        let escalamiento;
        try {
          escalamiento = await crearEscalamiento({
            hiloId: contexto.hiloId,
            mensajeId: contexto.mensajeId,
            remitente: contexto.remitente,
            asunto: contexto.asunto,
            motivo: args.motivo,
            resumenCorto: args.resumen_corto,
            descripcionDetallada: args.descripcion_detallada,
            datosEstudiante: args.datos_estudiante,
            datosInstitucion: args.datos_institucion,
            intentosPrevios: args.intentos_previos,
          });
        } catch (err) {
          console.error('[escalamiento] no se pudo crear el caso:', err);
          await registrarEvento(contexto.hiloId, {
            tipo: 'escalamiento_fallido',
            detalle: { motivo: args.motivo, error: String(err.message).slice(0, 300) },
          });
          contexto.errorCritico = 'escalamiento_fallido';
          return { status: 'ERROR', mensaje: 'No se pudo crear el caso. No respondas al usuario.' };
        }

        // Invariante: sin destinatario, el correo de delegación no llegaría a
        // ningún lado y el usuario quedaría esperando a un agente inexistente.
        if (!escalamiento?.correoDelegacion?.para) {
          console.error('[escalamiento] caso creado sin destinatario:', escalamiento?.codigo);
          await registrarEvento(contexto.hiloId, {
            tipo: 'escalamiento_sin_destinatario',
            detalle: { codigo: escalamiento?.codigo || null },
          });
          contexto.errorCritico = 'escalamiento_sin_destinatario';
          return { status: 'ERROR', mensaje: 'El caso no tiene agente asignado. No respondas al usuario.' };
        }
        await registrarEvento(contexto.hiloId, {
          tipo: 'escalado_a_agente',
          detalle: { codigo: escalamiento.codigo, agenteEmail: escalamiento.agenteEmail, motivo: args.motivo },
        });
        contexto.escalamiento = escalamiento;
        // Al modelo solo le interesa el código para informar al usuario;
        // el correo de delegación lo envía n8n, no el modelo.
        return { status: 'OK', codigo: escalamiento.codigo };
      }
      case 'consultar_estudiantes_activos': {
        let idColegio = args.id_colegio;
        if (!idColegio && args.colegio) {
          const resColegio = await buscarColegio({
            colegio: args.colegio,
            ciudad: args.ciudad || 'n/a',
            canton: args.canton || 'n/a',
          });
          if (resColegio.status !== 'OK') return resColegio;
          idColegio = resColegio.colegio._id;
        }
        if (!idColegio) {
          return { error: 'Falta el id del colegio (Pegasus) o el nombre del colegio' };
        }
        const resultado = await contarEstudiantesActivos({ idColegio });
        await registrarEvento(contexto.hiloId, {
          tipo: 'consulta_estudiantes_activos',
          detalle: { idColegio, status: resultado.status },
        });
        return resultado;
      }
      case 'crear_ticket': {
        const faltan = validarDatosTicket(args);
        if (faltan) {
          await registrarEvento(contexto.hiloId, {
            tipo: 'ticket_bloqueado_falta_info',
            detalle: { tipo: args.tipo, faltan: faltan.faltan },
          });
          contexto.esperandoInfoUsuario = true;
          return faltan;
        }
        // El ticket viaja solo: todo lo que el equipo necesita saber va en la
        // descripción, porque no tiene acceso al hilo de correo. Se lista en el
        // mismo orden en que se le piden los datos al usuario.
        const usuarioAfectado = args.nombre_estudiante;
        const institucion = [args.institucion, dato(args.ciudad), dato(args.canton)].filter(Boolean).join(', ');
        const descripcionCompleta = [
          `Estudiante: ${usuarioAfectado}`,
          `Unidad educativa: ${args.institucion}`,
          `Ciudad (provincia): ${args.ciudad}`,
          dato(args.canton) ? `Cantón: ${args.canton}` : null,
          `Nivel: ${args.nivel}`,
          `Paralelo: ${args.paralelo}`,
          dato(args.plataforma) ? `Plataforma: ${args.plataforma}` : null,
          dato(args.descripcion) ? `\nDetalle del problema:\n${args.descripcion}` : null,
          `\nSolicitado por: ${contexto.remitente}`,
        ]
          .filter(Boolean)
          .join('\n');

        const ticket = await crearTicket({
          hiloId: contexto.hiloId,
          tipo: args.tipo,
          equipo: args.equipo,
          descripcion: descripcionCompleta,
          adjuntos: contexto.adjuntos || [],
          reportadoPor: contexto.remitente,
          asuntoOriginal: contexto.asunto,
          usuarioAfectado,
          institucion,
          plataforma: dato(args.plataforma),
        });

        // Invariante: igual que en la derivación, un ticket sin destinatario no
        // lo atiende nadie — y al cliente ya se le habría dicho que sí.
        if (!ticket?.correoTicket?.para) {
          console.error('[ticket] sin destinatario:', ticket?.jiraKey);
          await registrarEvento(contexto.hiloId, {
            tipo: 'ticket_sin_destinatario',
            detalle: { jiraKey: ticket?.jiraKey || null, equipo: args.equipo },
          });
          contexto.errorCritico = 'ticket_sin_destinatario';
          return { status: 'ERROR', mensaje: 'El ticket no tiene equipo asignado. No respondas al usuario.' };
        }
        await registrarEvento(contexto.hiloId, {
          tipo: 'ticket_creado',
          detalle: { jiraKey: ticket.jiraKey, tipo: ticket.tipo, enlazadoA: ticket.enlazadoA },
        });
        contexto.ultimoTicket = ticket;
        return ticket;
      }
      case 'info_pin': {
        await registrarEvento(contexto.hiloId, {
          tipo: 'pin_info',
          detalle: { pinNoFunciona: Boolean(args.pin_no_funciona) },
        });
        // Toda consulta de PIN se resuelve con este mini tutorial de dónde
        // encontrarlo. No hay forma automática de validar un PIN.
        return {
          tutorial: [
            'Toma el libro de "Compartir" del estudiante.',
            'Voltea el libro y revisa el reverso (la contraportada).',
            'Ahí está impreso el PIN de acceso.',
            'Ingresa ese PIN en la plataforma para activar el libro.',
          ],
          nota: args.pin_no_funciona
            ? 'Si después de seguir estos pasos el PIN sigue sin funcionar, pide al usuario que responda a este mismo correo indicándolo, para revisarlo manualmente.'
            : null,
        };
      }
      case 'fuera_de_alcance': {
        await registrarEvento(contexto.hiloId, { tipo: 'fuera_de_alcance', detalle: {} });
        contexto.fueraDeAlcance = true;
        return { mensaje: 'Esta consulta no corresponde a las funciones de soporte de Santillana.' };
      }
      default:
        return { error: `Herramienta desconocida: ${nombre}` };
    }
  } catch (err) {
    return { error: `Error ejecutando ${nombre}: ${err.message}` };
  }
}

// Las plantillas ya no escriben la despedida: la firma corporativa se pega
// una sola vez al final (conFirmaTexto / textoAHtml), para que TODAS las
// salidas del sistema lleven exactamente la misma.
const FIRMA = '';

// Señales de que el modelo PROMETIÓ una acción (derivar el caso, crear un
// ticket) que en realidad no ejecutó, o de que inventó un código.
const PROMESAS_SIN_ACCION = [
  /\[c[oó]digo del caso\]/i,
  /\[c[oó]digo\]/i,
  /\[?(?:PENDIENTE|TICKET)-X{3,}\]?/i,
  /CASO-X{3,}/i,
  // Escalamiento prometido
  /\bhemos generado el caso\b/i,
  /\bgeneramos el caso\b/i,
  /\bser[áa] atendid[oa] por (?:un|uno de nuestros) agentes? digital(?:es)?/i,
  /\bderivamos? (?:tu|su) (?:caso|solicitud)\b/i,
  /\b(?:se )?(?:ha|hemos)? ?derivad[oa] (?:tu|su|el) (?:caso|solicitud)\b/i,
  // Ticket prometido. El modelo lo redactaba de mil formas ("se ha generado un
  // ticket", "hemos creado un ticket"...) sin haber llamado a crear_ticket, y
  // el usuario quedaba esperando una gestión que nunca existió.
  /\b(?:se\s+)?(?:ha|han|hemos|he)\s+(?:generad|cread|abiert|registrad)[oa]s?\s+(?:un|el|su|tu)?\s*(?:ticket|caso|solicitud de soporte|requerimiento)\b/i,
  /\b(?:generamos|creamos|abrimos|registramos)\s+(?:un|el|su|tu)?\s*(?:ticket|caso|requerimiento)\b/i,
  /\b(?:se\s+)?(?:gener[óo]|cre[óo]|abri[óo]|registr[óo])\s+(?:un|el|su|tu)?\s*(?:ticket|caso|requerimiento)\b/i,
  /\bticket (?:fue |ha sido |queda )?(?:generado|creado|abierto|registrado)\b/i,
  /\bqued[óo] (?:generado|creado|abierto|registrado) (?:el |un )?(?:ticket|caso)\b/i,
];

/**
 * Red de seguridad: si el texto promete un escalamiento o un ticket que no se
 * ejecutó (el modelo no llamó a la herramienta), no podemos enviarlo — el
 * usuario quedaría esperando algo que nunca ocurrió. Devuelve true si el texto
 * es una promesa vacía.
 */
export function prometeAccionNoRealizada(texto, contexto) {
  if (contexto.escalamiento || contexto.ultimoTicket) return false;
  return PROMESAS_SIN_ACCION.some((re) => re.test(texto));
}

/**
 * Ahorro de cuota: para las herramientas cuyo desenlace es DETERMINISTA
 * (tutorial del PIN, ticket creado, caso derivado, fuera de alcance), el
 * correo de respuesta se redacta aquí con una plantilla, evitando la llamada
 * extra a Gemini que solo serviría para formatear un resultado fijo. Devuelve
 * null cuando la respuesta sí requiere redacción del modelo (búsquedas de
 * credenciales/estudiantes, resultados con error): en esos casos interpretar
 * el resultado y decidir qué preguntar es justo donde el LLM aporta calidad.
 */
export function redactarRespuestaDeterminista(nombre, resultado) {
  if (!resultado || resultado.error) return null;

  // Faltan datos para crear el ticket / derivar el caso: la respuesta es la
  // lista de lo que falta, que ya calculó la validación. Redactarla aquí
  // garantiza que la petición SIEMPRE se envíe (el modelo no puede "olvidarla")
  // y ahorra una llamada al modelo.
  if (resultado.status === 'FALTA_INFORMACION' && Array.isArray(resultado.faltan) && resultado.faltan.length > 0) {
    return (
      'Hola, gracias por escribirnos.\n\n' +
      'Con gusto atendemos su solicitud. Para poder gestionarla necesitamos algunos datos; ' +
      '¿podría respondernos a este mismo correo indicando lo siguiente?\n\n' +
      resultado.faltan.map((f) => `- ${f}`).join('\n') +
      '\n\nSi alguno de esos datos no lo tiene a la mano, indíquenoslo también y continuamos con lo que haya.' +
      FIRMA
    );
  }

  switch (nombre) {
    case 'info_pin': {
      if (!Array.isArray(resultado.tutorial) || resultado.tutorial.length === 0) return null;
      const pasos = resultado.tutorial.map((p, i) => `${i + 1}. ${p}`).join('\n');
      return (
        'Gracias por escribirnos. Aquí tienes los pasos para encontrar el PIN de acceso:\n\n' +
        pasos +
        (resultado.nota ? `\n\n${resultado.nota}` : '') +
        '\n\nSi necesitas algo más, puedes responder a este mismo correo.' +
        FIRMA
      );
    }
    case 'crear_ticket': {
      if (!resultado.jiraKey) return null;
      const motivo =
        resultado.tipo === 'reset_password'
          ? 'el reseteo de la contraseña'
          : 'revisar la incidencia que reportaste en la plataforma';
      const equipo = resultado.equipo === 'cuentas' ? 'Cuentas' : 'Servicio Digital';
      return (
        `Gracias por escribirnos. Generamos el ticket ${resultado.jiraKey} para ${motivo}; ` +
        `lo atenderá nuestro equipo de ${equipo} y la respuesta llegará a este mismo correo cuando esté resuelto.` +
        (resultado.enlazadoA
          ? `\n\nEste ticket quedó enlazado a tu caso anterior (${resultado.enlazadoA}).`
          : '') +
        FIRMA
      );
    }
    case 'derivar_a_agente_digital': {
      if (resultado.status !== 'OK' || !resultado.codigo) return null;
      return (
        'Gracias por la información. Tu caso será atendido por un agente digital de servicio.\n\n' +
        `Código del caso: ${resultado.codigo}\n\n` +
        'La respuesta te llegará a este mismo hilo de correo; si deseas agregar más información, puedes responder aquí mismo.' +
        FIRMA
      );
    }
    case 'fuera_de_alcance':
      return (
        'Hola, gracias por escribirnos.\n\n' +
        'Este correo de soporte de Santillana Ecuador atiende los siguientes temas:\n\n' +
        '- Credenciales de acceso de estudiantes (usuario y contraseña)\n' +
        '- PIN de acceso del libro de "Compartir"\n' +
        '- Reseteo de contraseñas\n' +
        '- Incidencias de la plataforma (contenido o clases que no se ven)\n\n' +
        'Tu consulta parece ser de otro tema, así que te recomendamos dirigirla al canal correspondiente. ' +
        'Si tu consulta sí está relacionada con alguno de los puntos de la lista, respóndenos por este ' +
        'mismo correo con un poco más de detalle y con gusto te atendemos.' +
        FIRMA
      );
    default:
      return null;
  }
}

/**
 * Procesa un correo entrante con Gemini + function calling.
 * Como Lambda es stateless, el historial de la conversación se reconstruye
 * desde Mongo (colección conversaciones) en cada invocación, en vez de
 * mantenerse en memoria entre llamadas.
 */
export async function procesarCorreo({
  hiloId,
  mensajeId,
  remitente,
  cuentaSoporte,
  asunto,
  cuerpo,
  adjuntos = [],
  // n8n lo marca cuando el trigger de Outlook viene con "Simplify" encendido:
  // en ese modo Graph entrega solo `bodyPreview`, que corta el correo a ~255
  // caracteres. Es la causa de que el asistente volviera a pedir datos que el
  // usuario SÍ había escrito: simplemente nunca los recibió.
  cuerpoTruncado = false,
}) {
  const norm = (c) => String(c || '').trim().toLowerCase();

  // 0a. Nunca procesar correos que salieron de la propia cuenta de soporte
  //     (las respuestas del asistente): evita bucles de auto-respuesta.
  if (remitente && cuentaSoporte && norm(remitente) === norm(cuentaSoporte)) {
    return { hiloId, accion: 'ninguna', motivo: 'remitente_es_la_cuenta_de_soporte' };
  }

  // El cuerpo llega de Outlook como HTML y, en las respuestas, con TODO el
  // hilo citado debajo ("De: ... Enviado: ..."). Sin esta limpieza, el modelo
  // recibe sus propios correos anteriores dentro del mensaje del usuario y
  // termina "conversando consigo mismo".
  cuerpo = limpiarCuerpoCorreo(cuerpo);
  if (!cuerpo) {
    return { hiloId, accion: 'ninguna', motivo: 'correo_sin_contenido_nuevo' };
  }

  // 0c. Correo basura (publicidad, notificaciones automáticas, rebotes,
  //     avisos de ausencia): no se responde ni se crea conversación — solo se
  //     deja registro para poder afinar el filtro. n8n lo mueve a Correo no
  //     deseado. Se comprueba antes de tocar Mongo y antes de gastar cuota de
  //     IA, que es justo lo que consumía la publicidad.
  const basura = clasificarCorreoBasura({ remitente, asunto, cuerpo });
  const col = await coleccionConversaciones();
  if (basura) {
    // Salvo que el hilo ya sea una conversación real en curso (un usuario que
    // reenvía algo dentro de su propio caso no debe silenciarse).
    const existente = await col.findOne({ _id: hiloId }, { projection: { mensajes: 1 } });
    const hiloEnCurso = (existente?.mensajes || []).some((m) => m.rol === 'asistente');
    if (!hiloEnCurso) {
      console.log(`[basura] ${basura.categoria}: ${basura.senal} | de=${remitente} | asunto=${asunto || ''}`);
      await registrarDescarte({
        hiloId,
        mensajeId,
        remitente,
        asunto,
        categoria: basura.categoria,
        senal: basura.senal,
      });
      return {
        hiloId,
        accion: 'ignorar',
        motivo: 'correo_basura',
        categoria: basura.categoria,
        senal: basura.senal,
      };
    }
  }

  await obtenerOCrearConversacion({ hiloId, remitente, cuentaSoporte, asunto });
  let conversacion = await col.findOne({ _id: hiloId });

  // 0b. Guarda robusta anti-bucle: en un REPLY enviado por el asistente, el
  //     "to" es el cliente, así que la comparación 0a no lo detecta (from =
  //     soporte, to = cliente). La conversación en Mongo sí sabe cuál es la
  //     cuenta de soporte del hilo (se guardó con el primer correo del
  //     cliente): si el remitente de este correo ES esa cuenta, es una
  //     respuesta nuestra que el trigger volvió a levantar. Se ignora.
  if (conversacion?.cuentaSoporte && norm(remitente) === norm(conversacion.cuentaSoporte)) {
    return { hiloId, accion: 'ninguna', motivo: 'remitente_es_la_cuenta_de_soporte_del_hilo' };
  }

  // 1. Idempotencia: no reprocesar un correo que ya fue respondido (duplicados
  //    de entrega o re-polls del trigger). Si el mensaje ya se vio PERO no tiene
  //    respuesta (un intento previo falló, p.ej. por cuota), se reprocesa sin
  //    duplicar el mensaje del usuario.
  if (mensajeId) {
    const msgs = conversacion.mensajes || [];
    const idxUser = msgs.findIndex((m) => m.rol === 'usuario' && m.mensajeId === mensajeId);
    if (idxUser !== -1) {
      const yaRespondido = msgs.slice(idxUser + 1).some((m) => m.rol === 'asistente');
      if (yaRespondido) {
        return { hiloId, accion: 'ninguna', duplicado: true };
      }
    } else {
      await registrarMensaje(hiloId, { rol: 'usuario', mensajeId, cuerpo, adjuntos });
      conversacion = await col.findOne({ _id: hiloId });
    }
  } else {
    await registrarMensaje(hiloId, { rol: 'usuario', cuerpo, adjuntos });
    conversacion = await col.findOne({ _id: hiloId });
  }

  // Historial de solo texto (usuario/asistente); no se reintenta reproducir
  // tool calls pasados — si el modelo necesita el dato de nuevo, vuelve a
  // llamar la herramienta, lo cual además refleja datos actualizados.
  // Los mensajes de usuario se vuelven a limpiar aquí porque los hilos
  // guardados ANTES de este fix quedaron en Mongo con el HTML y el hilo
  // citado completos; limpiar al reconstruir sanea también ese historial
  // viejo. Se acota a los últimos 20 mensajes para no inflar el prompt.
  const contents = (conversacion.mensajes || [])
    .filter((m) => m.rol === 'usuario' || m.rol === 'asistente')
    .map((m) => ({
      role: m.rol === 'usuario' ? 'user' : 'model',
      parts: [{ text: m.rol === 'usuario' ? limpiarCuerpoCorreo(m.cuerpo) : String(m.cuerpo || '') }],
    }))
    .filter((c) => c.parts[0].text.trim() !== '')
    .slice(-20);

  // El correo llegó recortado: se avisa al modelo para que no confunda "dato
  // ausente" con "dato cortado" y vuelva a pedir lo que el usuario ya escribió.
  // Queda además registrado para que el problema sea visible en la analítica.
  if (cuerpoTruncado) {
    console.warn(`[correo_truncado] hilo=${hiloId} — apaga "Simplify" en el trigger de Outlook de n8n`);
    await registrarEvento(hiloId, { tipo: 'correo_truncado', detalle: { mensajeId: mensajeId || null } });
    contents.push({
      role: 'user',
      parts: [{
        text:
          'AVISO DEL SISTEMA: el correo anterior llegó cortado por el proveedor y puede faltarle el ' +
          'final. Si parece incompleto o termina a mitad de una frase, pídele al usuario que reenvíe ' +
          'esa parte; no des por ausente un dato que quizá sí escribió.',
      }],
    });
  }

  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const contexto = {
    hiloId, mensajeId, remitente, asunto, adjuntos,
    ultimoTicket: null, escalamiento: null,
    esperandoInfoUsuario: false, fueraDeAlcance: false,
    huboTools: false,
    // Se llena si una herramienta imprescindible falló: aborta la respuesta.
    errorCritico: null,
    // Cuántos correos ha escrito el usuario en este hilo (incluido el actual).
    // Con 1 estamos en el primer contacto: no se deriva ni se crea un ticket
    // sin haberle preguntado antes lo que falta.
    turnosUsuario: (conversacion.mensajes || []).filter((m) => m.rol === 'usuario').length || 1,
  };
  const generarConfig = { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: TOOLS }] };

  let textoFinal;
  try {
    let respuesta = await generarConRespaldo(ai, { contents, config: generarConfig });

    let iteraciones = 0;
    while (respuesta.functionCalls && respuesta.functionCalls.length > 0 && iteraciones < MAX_ITERACIONES_TOOLS) {
      iteraciones++;
      contents.push({ role: 'model', parts: respuesta.candidates[0].content.parts });

      const partesResultado = [];
      let ultimoResultado = null;
      for (const fc of respuesta.functionCalls) {
        contexto.huboTools = true;
        const resultado = await ejecutarTool(fc.name, fc.args, contexto);
        partesResultado.push({ functionResponse: { name: fc.name, response: resultado } });
        ultimoResultado = resultado;
      }
      contents.push({ role: 'user', parts: partesResultado });

      // Corto-circuito de cuota: si la única herramienta de esta vuelta tiene
      // desenlace determinista, se redacta la respuesta con plantilla y se
      // evita la llamada extra a Gemini (que solo formatearía un dato fijo).
      if (respuesta.functionCalls.length === 1) {
        const plantilla = redactarRespuestaDeterminista(respuesta.functionCalls[0].name, ultimoResultado);
        if (plantilla) {
          textoFinal = plantilla;
          break;
        }
      }

      respuesta = await generarConRespaldo(ai, { contents, config: generarConfig });
    }
    if (textoFinal === undefined) textoFinal = respuesta.text;

    // El modelo prometió derivar el caso / crear un ticket pero no llamó a la
    // herramienta (llegó a escribir códigos tipo "[código del caso]"). Se le
    // devuelve el error y se le obliga a ejecutar la acción antes de responder.
    if (textoFinal && prometeAccionNoRealizada(textoFinal, contexto)) {
      await registrarEvento(hiloId, { tipo: 'promesa_sin_accion_corregida', detalle: {} });
      contents.push({ role: 'model', parts: [{ text: textoFinal }] });
      contents.push({
        role: 'user',
        parts: [{
          text:
            'AVISO DEL SISTEMA: tu respuesta anterior prometió una acción (derivar el caso o crear un ' +
            'ticket) que NO ejecutaste, o incluyó un código inventado. Esa respuesta no se envió. ' +
            'Si corresponde derivar o crear el ticket, llama AHORA a la herramienta correspondiente y ' +
            'usa el código real que devuelva. Si no corresponde, reescribe la respuesta sin prometer ' +
            'ninguna acción ni mencionar códigos.',
        }],
      });
      respuesta = await generarConRespaldo(ai, { contents, config: generarConfig });

      let reintentos = 0;
      while (respuesta.functionCalls && respuesta.functionCalls.length > 0 && reintentos < 2) {
        reintentos++;
        contents.push({ role: 'model', parts: respuesta.candidates[0].content.parts });
        const partes = [];
        let ultimo = null;
        for (const fc of respuesta.functionCalls) {
          contexto.huboTools = true;
          const res = await ejecutarTool(fc.name, fc.args, contexto);
          partes.push({ functionResponse: { name: fc.name, response: res } });
          ultimo = res;
        }
        contents.push({ role: 'user', parts: partes });

        if (respuesta.functionCalls.length === 1) {
          const plantilla = redactarRespuestaDeterminista(respuesta.functionCalls[0].name, ultimo);
          if (plantilla) {
            respuesta = { text: plantilla, functionCalls: [] };
            break;
          }
        }
        respuesta = await generarConRespaldo(ai, { contents, config: generarConfig });
      }
      textoFinal = respuesta.text;
    }
  } catch (err) {
    // 2. Se acabó la cuota / rate limit / error del proveedor de IA. NO le
    //    respondemos basura al usuario ni marcamos el correo como respondido:
    //    devolvemos un estado reintentable (el handler responde 503 y n8n no
    //    envía nada; el mismo correo se reprocesará limpio en el próximo intento).
    if (err.esErrorLLM) {
      await registrarEvento(hiloId, {
        tipo: err.esCuota ? 'error_llm_cuota' : 'error_llm',
        detalle: { mensaje: String(err.message).slice(0, 300) },
      });
      return {
        hiloId,
        accion: 'error_temporal',
        reintentable: true,
        motivo: err.esCuota ? 'cuota_agotada' : 'error_llm',
        mensaje: 'El servicio de IA no está disponible temporalmente (posible límite de cuota). No se envió respuesta.',
      };
    }
    throw err;
  }

  // Una herramienta crítica falló (no se pudo crear el caso / no hay agente al
  // que asignarlo). Responderle al usuario aquí sería mentirle: le diríamos que
  // su caso será atendido cuando no existe. Se corta sin enviar nada y n8n
  // reintenta (503), dejando el correo sin marcar como respondido.
  if (contexto.errorCritico) {
    return {
      hiloId,
      accion: 'error_temporal',
      reintentable: true,
      motivo: contexto.errorCritico,
      mensaje:
        'No se pudo asignar el caso o el ticket a nadie (revisa AGENTES_DIGITALES, ' +
        'CORREO_EQUIPO_CUENTAS / CORREO_EQUIPO_SERVICIO_DIGITAL y la conexión a Mongo). ' +
        'No se envió respuesta al usuario.',
    };
  }

  // Si el modelo no devolvió texto (raro, sin error del proveedor): tampoco
  // enviamos un genérico "no pude procesar"; se trata como temporal/reintentable.
  if (!textoFinal || !textoFinal.trim()) {
    await registrarEvento(hiloId, { tipo: 'error_llm_sin_texto', detalle: {} });
    return { hiloId, accion: 'error_temporal', reintentable: true, motivo: 'sin_texto' };
  }

  await registrarMensaje(hiloId, { rol: 'asistente', cuerpo: textoFinal });

  // Estado final de la conversación (define quién debe cerrar / esperar):
  //  - esperando_agente: se escaló a una persona.
  //  - cerrado: fuera de alcance (terminal, no se reabre solo).
  //  - esperando_usuario: se le pidió info y falta que responda (cierre a 24h).
  //  - resuelto: se entregó lo pedido (credencial, ticket, PIN...).
  let estado = 'resuelto';
  if (contexto.escalamiento) estado = 'esperando_agente';
  else if (contexto.fueraDeAlcance) estado = 'cerrado';
  else if (contexto.esperandoInfoUsuario) estado = 'esperando_usuario';
  // Si el modelo respondió SIN llamar a ninguna herramienta, es porque está
  // pidiendo datos al usuario (flujo iterativo de recolección): el hilo queda
  // esperando su respuesta, no resuelto.
  else if (!contexto.huboTools) estado = 'esperando_usuario';
  await actualizarEstado(hiloId, estado);

  // "accion" es la que usa el Switch de n8n para decidir la rama:
  //  - escalar: además de responder al usuario, enviar el correo de delegación al agente
  //  - responder_y_crear_ticket: rama donde se conectará el nodo Jira cuando salga de standby
  //  - responder: solo contestar el hilo
  let accion = 'responder';
  if (contexto.escalamiento) accion = 'escalar';
  else if (contexto.ultimoTicket) accion = 'responder_y_crear_ticket';

  return {
    hiloId,
    accion,
    estado,
    // Mensaje al que n8n debe responder. En el flujo normal es el correo que
    // acaba de llegar; en la respuesta de un agente (ver handler) es el correo
    // ORIGINAL del cliente. Tener un solo campo permite un único nodo Reply.
    //
    // SIEMPRE presente (null si no hay): si se omitiera, la expresión del nodo
    // Reply de n8n resolvería a undefined y Graph respondería
    // "ErrorInvalidIdMalformed" en vez de un error entendible.
    mensajeIdRespuesta: mensajeId || null,
    // El texto plano lleva la firma pegada; la version HTML la maqueta
    // textoAHtml. Por eso a textoAHtml se le pasa el texto SIN firmar.
    textoRespuesta: conFirmaTexto(textoFinal),
    // Versión HTML para el reply de Outlook: Graph renderiza el cuerpo como
    // HTML, así que los \n del texto plano colapsarían en un solo bloque.
    textoRespuestaHtml: textoAHtml(textoFinal),
    ticket: contexto.ultimoTicket,
    escalamiento: contexto.escalamiento,
  };
}
