import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { buscarEstudiante } from '../services/busqueda.js';
import { crearTicket } from '../services/tickets.js';
import { obtenerOCrearConversacion, registrarMensaje, registrarEvento } from '../services/conversaciones.js';
import { coleccionConversaciones } from '../db/mongo.js';

const MAX_ITERACIONES_TOOLS = 6;

const TOOLS = [
  {
    name: 'buscar_credenciales',
    description:
      'Busca las credenciales (login y contraseña) de un estudiante. Usa coincidencia difusa: ' +
      'tolera nombres incompletos en la base de datos (ej. solo un nombre y un apellido) y nombres ' +
      'de colegio escritos de forma aproximada. Llama a esta herramienta en cuanto tengas al menos ' +
      'el nombre del estudiante y el colegio; si falta la provincia, usa "n/a".',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        nombre_completo: { type: 'string', description: 'Nombre completo del estudiante' },
        nivel: { type: 'string', description: 'Nivel o grado del estudiante (si se conoce)' },
        paralelo: { type: 'string', description: 'Paralelo o grupo (si se conoce)' },
        colegio: { type: 'string', description: 'Nombre completo de la unidad educativa' },
        provincia: { type: 'string', description: 'Provincia del colegio; "n/a" si no se conoce' },
      },
      required: ['nombre_completo', 'colegio'],
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
Necesitas: nombre completo de la unidad educativa, provincia, nombre completo del estudiante, nivel y
paralelo. Si falta alguno, pídelo en tu respuesta; pero si ya tienes al menos nombre y colegio, intenta
buscar de todas formas (usa "n/a" para provincia si no la tienes) y usa el resultado para decidir qué
más preguntar.
Usa buscar_credenciales e interpreta el resultado:
- OK: entrega login y contraseña con claridad.
- COLEGIO_NO_ENCONTRADO: indica que no se encontró el colegio; si hay "sugerencias", muéstralas
  (nombre + provincia) para que el remitente confirme cuál es al responder este mismo correo.
- ESTUDIANTE_NO_ENCONTRADO: indícalo y sugiere revisar el nombre, nivel o paralelo.
- CANDIDATOS: el nombre en la base puede estar incompleto (ej. un nombre y un apellido). Muestra los
  candidatos (nombre, grado, grupo) y pide confirmar cuál corresponde, o el dato que falta.
- SIN_COLEGIOS: informa que aún no hay colegios cargados en el sistema.

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
          provincia: args.provincia || 'n/a',
        });
        await registrarEvento(contexto.hiloId, {
          tipo: `credencial_${String(resultado.status).toLowerCase()}`,
          detalle: { colegio: args.colegio, nombre: args.nombre_completo },
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
export async function procesarCorreo({ hiloId, remitente, cuentaSoporte, asunto, cuerpo, adjuntos = [] }) {
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
  const contexto = { hiloId, remitente, adjuntos, ultimoTicket: null };
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

  return { hiloId, textoRespuesta: textoFinal, ticket: contexto.ultimoTicket };
}
