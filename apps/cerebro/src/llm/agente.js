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
} from '../services/conversaciones.js';
import { coleccionConversaciones } from '../db/mongo.js';

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
ANTES de derivar un caso de credenciales de un estudiante, asegúrate de haber recopilado TODA la
información posible del estudiante, para que el agente humano no tenga que volver a pedirla: nombre
completo del estudiante, nivel y paralelo, nombre(s) de la unidad educativa que se intentaron, y
ciudad (provincia) y cantón. Si te falta algún dato clave y el usuario aún no lo dio, pídelo en tu
respuesta y espera a que responda ANTES de derivar; no deriva un caso a medias. Solo cuando ya no
haya más datos que pedir (o el usuario diga que no los tiene) procede con derivar_a_agente_digital,
e incluye en resumen_caso todos esos datos.
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
SIEMPRE genera un ticket (crear_ticket, tipo "reset_password", equipo "cuentas"). No intentes
resolverlo tú mismo ni inventes una contraseña nueva. Informa que se generó un ticket y que la
respuesta llegará a este mismo correo cuando esté resuelto.

## 3. PIN de acceso
Cualquier consulta sobre el PIN se responde con el mini tutorial que devuelve info_pin: explica al
usuario, paso a paso, dónde encontrarlo (está impreso en el reverso del libro de "Compartir").
Preséntalo como una lista numerada de pasos. Usa pin_no_funciona=false si solo preguntan dónde está,
y pin_no_funciona=true si reportan que no les funciona (en ese caso agrega la nota que devuelve la
herramienta). No inventes otros pasos ni prometas validar el PIN: no hay forma automática de hacerlo.

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
        // Si la búsqueda no fue directa (homónimos, colegio/estudiante no
        // encontrado, candidatos), el asistente le pedirá algo al usuario y
        // queda esperando su respuesta. Un OK se considera resuelto.
        contexto.esperandoInfoUsuario = ESTADOS_ESPERANDO_USUARIO.has(String(resultado.status));
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

/**
 * Procesa un correo entrante con Gemini + function calling.
 * Como Lambda es stateless, el historial de la conversación se reconstruye
 * desde Mongo (colección conversaciones) en cada invocación, en vez de
 * mantenerse en memoria entre llamadas.
 */
export async function procesarCorreo({ hiloId, mensajeId, remitente, cuentaSoporte, asunto, cuerpo, adjuntos = [] }) {
  // 0. Nunca procesar correos que salieron de la propia cuenta de soporte
  //    (las respuestas del asistente): evita bucles de auto-respuesta.
  if (
    remitente &&
    cuentaSoporte &&
    remitente.trim().toLowerCase() === cuentaSoporte.trim().toLowerCase()
  ) {
    return { hiloId, accion: 'ninguna', motivo: 'remitente_es_la_cuenta_de_soporte' };
  }

  await obtenerOCrearConversacion({ hiloId, remitente, cuentaSoporte, asunto });
  const col = await coleccionConversaciones();
  let conversacion = await col.findOne({ _id: hiloId });

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
  const contents = (conversacion.mensajes || [])
    .filter((m) => m.rol === 'usuario' || m.rol === 'asistente')
    .map((m) => ({ role: m.rol === 'usuario' ? 'user' : 'model', parts: [{ text: m.cuerpo }] }));

  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const contexto = {
    hiloId, mensajeId, remitente, asunto, adjuntos,
    ultimoTicket: null, escalamiento: null,
    esperandoInfoUsuario: false, fueraDeAlcance: false,
  };
  const generarConfig = { systemInstruction: SYSTEM_PROMPT, tools: [{ functionDeclarations: TOOLS }] };

  let textoFinal;
  try {
    let respuesta = await generarContenido(ai, {
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

      respuesta = await generarContenido(ai, {
        model: config.gemini.modelo,
        contents,
        config: generarConfig,
      });
    }
    textoFinal = respuesta.text;
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
    textoRespuesta: textoFinal,
    ticket: contexto.ultimoTicket,
    escalamiento: contexto.escalamiento,
  };
}
