import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { buscarEstudiante, buscarColegio, contarEstudiantesActivos } from '../services/busqueda.js';
import { crearTicket } from '../services/tickets.js';
import { crearEscalamiento } from '../services/escalamientos.js';
import { obtenerOCrearConversacion, registrarMensaje, registrarEvento } from '../services/conversaciones.js';
import { coleccionConversaciones } from '../db/mongo.js';

const MAX_ITERACIONES_TOOLS = 6;

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
      'Deriva el caso a una persona (agente digital de servicio). Úsala SOLO cuando el colegio no se ' +
      'encuentra después de haber pedido al usuario otro nombre con el que se conozca la institución: ' +
      'es decir, si el usuario dice que no conoce otro nombre, o si ya dio un nombre alternativo y la ' +
      'búsqueda volvió a fallar. NO la uses en el primer intento fallido.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          enum: ['colegio_no_encontrado', 'otro'],
          description: 'Motivo del escalamiento',
        },
        resumen_caso: {
          type: 'string',
          description:
            'Resumen completo para el agente humano: qué pide el usuario, nombre del estudiante, ' +
            'todos los nombres de colegio que se intentaron, ciudad/cantón si se conocen, y qué falló.',
        },
      },
      required: ['motivo', 'resumen_caso'],
    },
  },
  {
    name: 'consultar_estudiantes_activos',
    description:
      'Consulta cuántos estudiantes ACTIVOS tiene un colegio de Ecuador (un estudiante está activo ' +
      'cuando tiene PIN asociado). Acepta el id del colegio en Pegasus o el nombre del colegio.',
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
      '(tipo incidencia_plataforma, equipo servicio_digital).',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['reset_password', 'incidencia_plataforma'] },
        equipo: { type: 'string', enum: ['cuentas', 'servicio_digital'] },
        descripcion: { type: 'string', description: 'Descripción del problema reportado por el usuario' },
        usuario_afectado: { type: 'string', description: 'Nombre o correo del usuario afectado, si se conoce' },
      },
      required: ['tipo', 'equipo', 'descripcion'],
    },
  },
  {
    name: 'info_pin',
    description: 'Responde consultas sobre el PIN de acceso del libro de "Compartir".',
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

## 1. Obtener credenciales de un estudiante
Necesitas: nombre de la unidad educativa, ciudad (provincia) y cantón, nombre completo del estudiante,
nivel y paralelo. Si falta alguno, pídelo en tu respuesta; pero si ya tienes al menos nombre y colegio,
intenta buscar de todas formas (usa "n/a" para los datos de ubicación que no tengas) y usa el
resultado para decidir qué más preguntar.
Usa buscar_credenciales e interpreta el resultado:
- OK: entrega login y contraseña con claridad (indica también la plataforma: Compartir o CREO).
- HOMONIMOS: hay dos o más colegios con nombre igual o muy parecido. Muestra las opciones con su
  ciudad (provincia) y cantón, y pide al usuario confirmar cuál corresponde. NUNCA elijas uno al azar.
- COLEGIO_NO_ENCONTRADO: sigue este flujo EN ORDEN, sin saltarte pasos:
  1. Si hay "sugerencias", muéstralas (nombre + ciudad + cantón) para que el remitente confirme.
  2. Si no hay sugerencias útiles (o el usuario ya las descartó), pregunta si conoce la institución
     por ALGÚN OTRO NOMBRE (nombre comercial, nombre anterior, siglas, etc.).
  3. Si el usuario da otro nombre, vuelve a buscar con ese nombre.
  4. SOLO si el usuario dice que no conoce otro nombre, o si la búsqueda con el nombre alternativo
     también falla, usa derivar_a_agente_digital con un resumen completo del caso.
- ESTUDIANTE_NO_ENCONTRADO: indícalo y sugiere revisar el nombre, nivel o paralelo.
- CANDIDATOS: el nombre en la base puede estar incompleto (ej. un nombre y un apellido). Muestra los
  candidatos (nombre, grado, grupo) y pide confirmar cuál corresponde, o el dato que falta.
- SIN_COLEGIOS: informa que aún no hay colegios cargados en el sistema.

## 1b. Derivación a un agente digital de servicio
Cuando uses derivar_a_agente_digital, la herramienta asigna el caso a una persona del equipo y
devuelve un código de caso. En tu respuesta al usuario: informa que su caso será atendido por un
agente digital de servicio, menciona el código del caso, y explica que la respuesta le llegará a este
mismo hilo de correo. No prometas tiempos exactos de respuesta.

## 1c. Estudiantes activos de un colegio
Si preguntan cuántos estudiantes activos tiene un colegio (un estudiante está activo cuando tiene PIN
asociado), usa consultar_estudiantes_activos (con el id de Pegasus si lo dan, o con el nombre del
colegio). Reporta el total, los activos y el desglose por plataforma si existe. Si devuelve HOMONIMOS,
pide ciudad/cantón para confirmar el colegio.

## 2. Reseteo de contraseña
SIEMPRE genera un ticket (crear_ticket, tipo "reset_password", equipo "cuentas"). No intentes
resolverlo tú mismo ni inventes una contraseña nueva. Informa que se generó un ticket y que la
respuesta llegará a este mismo correo cuando esté resuelto.

## 3. PIN de acceso
Si preguntan dónde encontrar el PIN, usa info_pin con pin_no_funciona=false (está en el reverso del
libro de "Compartir"). Si dicen que el PIN no funciona, usa info_pin con pin_no_funciona=true (de
momento no hay función automática para validarlo).

## 4. Incidencias de plataforma
Si reportan que no ven contenido, no ven sus clases, o algo similar, usa crear_ticket (tipo
"incidencia_plataforma", equipo "servicio_digital"), describiendo el problema con el detalle que dio
el usuario. Menciona si hay adjuntos relevantes.

## 5. Fuera de alcance
Si la consulta no tiene que ver con Santillana ni con las funciones anteriores, usa fuera_de_alcance
y responde de forma amable indicando que no puedes ayudar con eso.

## Reglas generales
- No inventes datos: solo entrega credenciales que devuelva la herramienta.
- No muestres datos de un estudiante distinto al que el usuario pidió.
- Sé preciso sobre por qué falló una búsqueda (colegio no encontrado vs estudiante no encontrado).
- Firma tus correos como "Soporte Santillana Ecuador".`;

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
        return resultado;
      }
      case 'derivar_a_agente_digital': {
        const escalamiento = await crearEscalamiento({
          hiloId: contexto.hiloId,
          mensajeId: contexto.mensajeId,
          remitente: contexto.remitente,
          asunto: contexto.asunto,
          motivo: args.motivo,
          resumen: args.resumen_caso,
        });
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
        const ticket = await crearTicket({
          hiloId: contexto.hiloId,
          tipo: args.tipo,
          equipo: args.equipo,
          descripcion: args.descripcion,
          adjuntos: contexto.adjuntos || [],
          reportadoPor: contexto.remitente,
        });
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
        return args.pin_no_funciona
          ? {
              mensaje:
                'De momento no contamos con una función automática para validar si el PIN funciona. Este caso requiere revisión manual.',
            }
          : { mensaje: 'El PIN de acceso se encuentra en el reverso del libro de "Compartir".' };
      }
      case 'fuera_de_alcance': {
        await registrarEvento(contexto.hiloId, { tipo: 'fuera_de_alcance', detalle: {} });
        return { mensaje: 'Esta consulta no corresponde a las funciones de soporte de Santillana.' };
      }
      default:
        return { error: `Herramienta desconocida: ${nombre}` };
    }
  } catch (err) {
    return { error: `Error ejecutando ${nombre}: ${err.message}` };
  }
}

/**
 * Procesa un correo entrante con Gemini + function calling.
 * Como Lambda es stateless, el historial de la conversación se reconstruye
 * desde Mongo (colección conversaciones) en cada invocación, en vez de
 * mantenerse en memoria entre llamadas.
 */
export async function procesarCorreo({ hiloId, mensajeId, remitente, cuentaSoporte, asunto, cuerpo, adjuntos = [] }) {
  await obtenerOCrearConversacion({ hiloId, remitente, cuentaSoporte, asunto });
  await registrarMensaje(hiloId, { rol: 'usuario', cuerpo, adjuntos });

  const col = await coleccionConversaciones();
  const conversacion = await col.findOne({ _id: hiloId });

  // Historial de solo texto (usuario/asistente); no se reintenta reproducir
  // tool calls pasados — si el modelo necesita el dato de nuevo, vuelve a
  // llamar la herramienta, lo cual además refleja datos actualizados.
  const contents = (conversacion.mensajes || [])
    .filter((m) => m.rol === 'usuario' || m.rol === 'asistente')
    .map((m) => ({ role: m.rol === 'usuario' ? 'user' : 'model', parts: [{ text: m.cuerpo }] }));

  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const contexto = { hiloId, mensajeId, remitente, asunto, adjuntos, ultimoTicket: null, escalamiento: null };
  const generarConfig = { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: TOOLS }] };

  let respuesta = await ai.models.generateContent({
    model: config.gemini.modelo,
    contents,
    config: generarConfig,
  });

  let iteraciones = 0;
  while (respuesta.functionCalls && respuesta.functionCalls.length > 0 && iteraciones < MAX_ITERACIONES_TOOLS) {
    iteraciones++;
    contents.push({ role: 'model', parts: respuesta.candidates[0].content.parts });

    const partesResultado = [];
    for (const fc of respuesta.functionCalls) {
      const resultado = await ejecutarTool(fc.name, fc.args, contexto);
      partesResultado.push({ functionResponse: { name: fc.name, response: resultado } });
    }
    contents.push({ role: 'user', parts: partesResultado });

    respuesta = await ai.models.generateContent({
      model: config.gemini.modelo,
      contents,
      config: generarConfig,
    });
  }

  const textoFinal = respuesta.text || 'No pude procesar la solicitud, por favor intenta de nuevo.';
  await registrarMensaje(hiloId, { rol: 'asistente', cuerpo: textoFinal });

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
    textoRespuesta: textoFinal,
    ticket: contexto.ultimoTicket,
    escalamiento: contexto.escalamiento,
  };
}
