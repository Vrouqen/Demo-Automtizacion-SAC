# Demo Automatización SAC — Piloto de soporte por correo

Piloto de un asistente de soporte de Santillana Ecuador que atiende por **correo electrónico**
(Outlook empresarial), usando **Google Gemini** (gratuito, Google AI Studio) con function calling
para consultar credenciales de estudiantes en MongoDB, resolver dudas de PIN, generar tickets
(Jira externo, **actualmente en standby**) y **escalar a un agente digital de servicio** los casos
que no puede resolver.

> Migrado desde una versión anterior por WhatsApp/Anthropic (`git log` conserva ese historial).
> Todo lo desplegado en este piloto usa exclusivamente capas gratuitas — ver el desglose de costos
> en `docs/SETUP_AWS.md`. La migración de la base de Mongo Atlas a AWS está documentada en
> `docs/MIGRACION_MONGO_AWS.md`.

## Arquitectura

```
Correo entrante (buzón compartido de soporte, Outlook 365)
        ↓
n8n (UN SOLO flujo): Outlook Trigger → Code arma payload
        ↓
n8n: HTTP Request → apps/cerebro (AWS Lambda, Function URL)
        ↓
cerebro: primero decide QUÉ ES el correo:
  - ¿Es la respuesta de un agente a un caso delegado? (se reconoce por el conversationId
    del hilo de delegación guardado en Mongo, NO por el asunto) → devuelve la respuesta
    del agente y el mensajeId del correo ORIGINAL del cliente.
  - ¿Es basura? (publicidad, newsletter, buzón no-reply, aviso de ausencia, rebote)
    → accion "ignorar": no se responde ni se gasta cuota de IA; n8n lo mueve a
    Correo no deseado.
  - Si no, es una consulta: Gemini + function calling decide la intención:
      buscar_credenciales          → busca en Mongo (fuzzy match colegio + estudiante,
                                      con región/ciudad/cantón para separar HOMÓNIMOS)
      derivar_a_agente_digital     → crea [CASO-XXXXXX] y lo asigna (round-robin) a un
                                      agente digital, con el caso documentado en detalle
      consultar_estudiantes_activos → estudiantes activos de un colegio
      crear_ticket                 → registra el ticket en Mongo (Jira real en standby)
      info_pin                     → mini tutorial de dónde está el PIN
      fuera_de_alcance             → respuesta fija de cortesía
        ↓
n8n Switch según "accion":
  - escalar   → envía el correo de DELEGACIÓN al agente, registra el hilo de delegación
                (?accion=registrar_delegacion) y avisa al cliente en su mismo hilo
  - ignorar   → mueve el correo a Correo no deseado, sin responder
  - el resto  → responde el correo sobre "mensajeIdRespuesta" (un único nodo Reply):
                para una consulta normal es el correo entrante; para la respuesta de un
                agente es el correo ORIGINAL del cliente, así la solución llega a su hilo.
```

Cada conversación (hilo de correo), ticket, evento y escalamiento queda registrado en Mongo
(colecciones `conversaciones` y `escalamientos`) — es la fuente de la analítica del piloto
(`GET /?reporte=analitica` en el cerebro).

## Estructura del repo (monorepo)

```
apps/
  cerebro/                # Lambda: Gemini + Mongo + analítica + escalamientos + tickets (stub Jira)
  carga-credenciales/     # Lambda: sube un Excel de credenciales (cifradas) a Mongo
docs/
  SETUP_AWS.md            # Guía paso a paso: ECR, Lambda, Function URL, variables (incl. clave de cifrado)
  SETUP_N8N.md            # Guía paso a paso: Azure AD, buzones, flujo 1 y flujo 2 de n8n
  MIGRACION_MONGO_AWS.md  # Cómo mover la base de Mongo Atlas a AWS (EC2 o DocumentDB)
n8n/
  workflow-soporte-correo.json    # Flujo único: todo correo → cerebro → respuesta / escalamiento
  workflow-cierre-inactivas.json  # Programado: cierra casos sin respuesta del usuario
```

Cada app en `apps/` es un Lambda independiente (imagen Docker) con su propio `package.json` — no
comparten `node_modules`. Instala y prueba cada una por separado:

```bash
cd apps/cerebro && npm install && cp .env.example .env          # completa las variables
cd apps/carga-credenciales && npm install && cp .env.example .env
```

## Despliegue

Ver **`docs/SETUP_AWS.md`** (AWS: ECR, Lambda como imagen de contenedor, Function URL, variables) y
**`docs/SETUP_N8N.md`** (Microsoft Entra ID, buzones compartidos, los dos workflows de n8n).

## `apps/cerebro`

Recibe (vía Function URL) el correo ya parseado por n8n y responde con el texto para contestar en el
mismo hilo.

**`POST /`** — body JSON:
```json
{
  "hiloId": "conversationId de Outlook/Graph",
  "mensajeId": "id del mensaje (para el reply threaded)",
  "remitente": "docente@colegio.edu.ec",
  "cuentaSoporte": "soporte1@empresa.com",
  "asunto": "...",
  "cuerpo": "texto del correo",
  "adjuntos": []
}
```
Responde: `{ hiloId, accion, textoRespuesta, ticket, escalamiento }`:
- `accion`: `"responder"` | `"responder_y_crear_ticket"` | `"escalar"` (la usa el Switch de n8n).
- `escalamiento` (solo al escalar): `{ codigo, agenteEmail, correoDelegacion: { para, asunto, cuerpo } }`
  — el correo de delegación listo para que n8n lo envíe tal cual al agente digital.

**`POST /?accion=registrar_delegacion`** — body `{ codigo, conversationIdDelegacion,
mensajeIdDelegacion }`. Lo llama n8n justo después de enviar el correo de delegación; es lo que
permite reconocer la respuesta del agente por hilo y no por el asunto.

Las respuestas de los agentes **no necesitan endpoint propio**: entran por el `POST /` normal y el
cerebro las detecta, devolviendo `accion: "responder_al_cliente"` con el `mensajeIdRespuesta` del
correo original del cliente. (`POST /?accion=respuesta_agente` sigue existiendo por compatibilidad.)

**`GET /?vista=dashboard`** — dashboard de analítica en vivo (se refresca solo cada 30 s). Se sirve
desde la misma Function URL que los datos, así que no hace falta hosting ni dominio aparte.

**`GET /?reporte=analitica[&desde=&hasta=]`** — los mismos datos en JSON. Ver *Analítica* más abajo.

Ambos aceptan `&token=` y lo **exigen** si se define `DASHBOARD_TOKEN` (la Function URL es pública).

**`GET /?reporte=estudiantes_activos&idColegio=<id Pegasus>`** — cantidad de estudiantes activos del
colegio (**activo = tiene credenciales cargadas**, es decir login y contraseña), con desglose por
plataforma (Compartir/CREO).

### Funciones que maneja el LLM

- **Credenciales de estudiante**: pide nombre completo, nivel, paralelo, colegio, ciudad (provincia)
  y cantón. Tolera nombres incompletos en la base y nombres de colegio aproximados mediante
  coincidencia difusa propia (`utils/similitud.js`). Manejo de **colegios homónimos**: si dos o más
  colegios tienen nombre igual o muy parecido, no adivina — muestra las opciones con su ciudad y
  cantón para que el remitente confirme cuál es.
- **Escalamiento a un agente digital**: antes de derivar, el asistente **exige el detalle del
  caso** (qué necesita el usuario y desde cuándo, mensaje de error, datos del estudiante, nombres
  alternativos de la institución, qué intentó por su cuenta) para que la persona que lo atienda no
  tenga que volver a preguntar. Para un colegio no encontrado: primero muestra sugerencias; si no
  sirven, pregunta por **otro nombre** de la institución; si el usuario lo da, vuelve a buscar; solo
  si dice que no (o la segunda búsqueda también falla) **deriva el caso a un agente digital**: se le envía un correo de delegación con el código `[CASO-XXXXXX]` y
  al cliente se le avisa en su mismo hilo. Cuando el agente responde, su respuesta vuelve al cliente
  **por el hilo del correo inicial** (flujo 2 de n8n).
- **Estudiantes activos**: consulta por id de Pegasus o nombre de colegio cuántos estudiantes
  activos tiene (activo = con credenciales cargadas).
- **Reseteo de contraseña**: **siempre** genera un ticket (nunca lo resuelve el LLM directamente),
  pero solo después de tener el estudiante afectado, su institución y desde cuándo no puede acceder.
- **PIN de acceso**: toda consulta se responde con un **mini tutorial** de dónde encontrarlo (está
  impreso en el reverso del libro "Compartir"). Es el PIN del libro físico — no tiene relación con
  las credenciales que se cargan por Excel. No hay forma automática de validar un PIN.
- **Incidencias de plataforma**: genera un ticket para el equipo de servicio digital.
- **Fuera de alcance**: responde amablemente que no aplica.

### Qué datos se piden, en qué orden, y por qué el cantón no está

La lista es **la misma en los tres flujos** (credenciales, reseteo, incidencia) y está definida una
sola vez —`DATOS_ESTUDIANTE` en `llm/agente.js`— para que el prompt y la validación no se puedan
desincronizar:

1. Nombre completo del estudiante
2. Unidad educativa (colegio)
3. Ciudad (provincia)
4. Nivel
5. Paralelo

En una incidencia de plataforma se añade al final **Detalle minucioso del problema**.

**El cantón no está en la lista a propósito.** La mayoría de la gente no lo sabe de memoria, así que
pedirlo de entrada añade fricción a todas las conversaciones para resolver unas pocas. Solo se pide
después, y únicamente si la búsqueda del colegio devuelve `HOMONIMOS` o `COLEGIO_NO_ENCONTRADO`, que
es lo único para lo que sirve: desempatar entre colegios. Si el usuario lo da por su cuenta, se usa.

### Puerta de datos mínimos (no se actúa a ciegas)

El prompt pide recopilar información antes de crear un ticket o derivar un caso, pero un prompt no
es una garantía: el modelo se saltaba el paso y prometía tickets o derivaciones con todos los campos
en "no proporcionado". La garantía dura vive en el código (`validarDatosTicket` /
`validarDatosDerivacion` en `llm/agente.js`):

- `crear_ticket` exige **usuario afectado**, **institución** y una descripción concreta.
- `derivar_a_agente_digital` **no puede derivar en el primer correo** salvo que el usuario ya haya
  escrito un caso completo; y solo se salta el requisito cuando él mismo dijo que no tiene los datos.
- Si faltan datos, la herramienta **no se ejecuta**: se devuelve `FALTA_INFORMACION` con la lista
  exacta de lo que falta, y esa lista se le envía al usuario tal cual (respuesta redactada por
  plantilla, así que la petición nunca se "olvida" y no cuesta cuota de IA). El hilo queda en
  `esperando_usuario` y entra al cierre automático a las 24 h si no responde.

Además, `prometeAccionNoRealizada` bloquea cualquier respuesta que anuncie un ticket o una
derivación que no se ejecutó ("se ha generado un ticket…" sin ticket real) y obliga al modelo a
rehacerla.

### Reparto de casos entre agentes digitales

El caso se asigna **al agente con menos casos abiertos** (`pendiente_agente`), no por turno rotativo.
La diferencia importa: un agente que ya resolvió sus diez casos está libre y vuelve a ser candidato,
mientras que quien acumula tres sin responder deja de recibir hasta descargarse. Empates: gana quien
lleve más tiempo sin recibir un caso; y a igualdad total, orden alfabético (para que sea
determinista y reproducible en pruebas). Ver `elegirAgenteMenosCargado` en `services/escalamientos.js`.

Si la creación del caso falla (sin `AGENTES_DIGITALES`, Mongo caído), el cerebro **no responde nada**
al usuario y devuelve 503 para que n8n reintente: prometerle un agente que no existe es peor que no
contestar.

### Firma corporativa

La firma vive en un único sitio (`utils/firma.js`) y se pega automáticamente a **todas** las salidas:
respuestas del asistente, plantillas, respuesta de un agente digital y correo de cierre. El modelo
tiene prohibido escribir despedida; si la escribe igual, se recorta antes de pegar la canónica, de
modo que nunca sale duplicada ni con datos de contacto inventados. El correo interno de delegación va
sin firma comercial.

Los logos (`src/assets/firma/`) tienen dos modos, según `FIRMA_LOGOS`: `url` los sirve desde la
propia Lambda en `?logo=<slug>` y los enlaza con `<img>` (opción B, no toca n8n, requiere
`CEREBRO_URL`); `cid` los adjunta en línea (opción A, requiere cambiar el nodo de respuesta de n8n).
Sin la variable, la firma sale solo con texto — nunca con imágenes rotas.

### Analítica y dashboard

La fuente de verdad son los **eventos** que cada conversación acumula (`eventos[]`), no contadores
agregados aparte: una métrica nueva se puede calcular hacia atrás sobre el histórico sin haberla
previsto. `services/analitica.js` deriva de ahí:

- **Embudo de resolución** y **tasa de automatización** — cuántas cerró el asistente sin una persona.
- **Tiempos** (mediana y p90): primera respuesta, cierre del hilo, respuesta del agente digital.
- **Credenciales**: búsquedas por resultado y tasa de acierto.
- **Escalamientos**: por motivo y carga por agente (abiertos / resueltos / horas medias).
- **Ruido**: correo basura filtrado por categoría, y qué porcentaje del total entrante era.
- **Salud del sistema**: escalamientos fallidos, correos truncados, respuestas corregidas antes de
  enviarse, acciones frenadas por falta de datos, cortes por cuota de IA.

El dashboard (`?vista=dashboard`) los dibuja con selector de rango y refresco automático. Es una sola
página autocontenida, sin dependencias externas.

### Tickets y enlazado (Jira en standby)

Cuando un hilo ya tiene un ticket y el usuario reporta *otro* problema distinto en el mismo hilo, el
sistema **no reutiliza ni reabre** el ticket anterior — crea uno nuevo y lo enlaza al anterior
(`enlazadoA`). Jira real está desactivado por defecto (`JIRA_HABILITADO=false`): los tickets quedan
en Mongo con `estado: "pendiente_jira"` (ver el `TODO` en `apps/cerebro/src/services/tickets.js`).

## `apps/carga-credenciales`

Sube un Excel de credenciales de **estudiantes** a Mongo, desde un formulario web o por API. Hace una
sola cosa: cargar credenciales a la base. **Solo se aceptan credenciales de `compartir` y `creo`.**

**Solo estudiantes**: si el Excel trae una pestaña **Docentes**, se ignora a propósito (el programa
ya no gestiona credenciales de docentes) y la respuesta lo informa en `hojasIgnoradas`. Un archivo
que *solo* tenga pestaña de Docentes se rechaza con error 400, para no cargar profesores como si
fueran alumnos.

**Carga progresiva por plataforma y periodo**: cada POST toca solo los registros de esa
plataforma+periodo y deja intactos los demás. Dentro de ellos **fusiona por persona** (identificada
por su login, o por su nombre completo si la fila no trae login): a quien ya existía se le actualizan
sus credenciales y a quien no, se le agrega. **No borra a quien no venga en el archivo**, así que una
carga parcial es segura.

**`GET /`** (sin query params) — formulario web. Pide usuario/contraseña (`APP_USUARIO`/`APP_CLAVE`),
encadena región → provincia → cantón, y autocompleta los datos de los colegios ya registrados.

**`POST /?login=1`** — body `{ usuario, clave }` → devuelve un token de sesión firmado (HMAC, 8 h).
Las demás rutas de datos exigen `Authorization: Bearer <token>`.

**`POST /`** — body JSON:
```json
{
  "idColegio": "COL-001",
  "codigoColegio": "UE-QUITO-01",
  "region": "Sierra",
  "ciudad": "Pichincha",
  "canton": "Quito",
  "nombreColegio": "Unidad Educativa San Francisco de Quito",
  "plataforma": "compartir",
  "periodo": "2026-2027",
  "nombreArchivo": "credenciales.xlsx",
  "archivoBase64": "<contenido del .xlsx en base64>"
}
```
- `idColegio` = id del colegio en **Pegasus**; `nombreColegio` = nombre **del avance**;
  `ciudad` = Ciudad (Provincia) — se acepta también la clave `provincia`.
- `plataforma` es obligatoria y solo acepta `compartir` o `creo`.
- `periodo` es obligatorio, con formato `AAAA-AAAA` (ej. `2026-2027`).
- Columnas del Excel (el orden no importa, se detectan por nombre): `Grado | Grupo |
  Apellido Paterno | Apellido Materno | Nombre | Login | Contraseña`.
- **Login y contraseña se cifran (AES-256-GCM) antes de guardarse en Mongo** con la clave
  `CREDENCIALES_ENC_KEY` (la misma que usa el cerebro para descifrar al responder).
- La respuesta trae `estudiantes: { filas, nuevos, actualizados, sinCambios, totalPeriodo,
  totalColegio }` y `hojasIgnoradas`.

**`GET /?listar=1`** — lista los colegios cargados (sin credenciales), con región/ciudad/cantón,
plataformas y periodos cargados, y cantidad de estudiantes.

> Esta app **solo sube credenciales**: no calcula ni muestra estados. Quién está activo lo deduce el
> cerebro al consultar (`?reporte=estudiantes_activos`), a partir de si el estudiante tiene
> credenciales cargadas.

## Seguridad

- **Credenciales cifradas en reposo**: login y contraseña se guardan cifrados (AES-256-GCM,
  clave de 32 bytes en `CREDENCIALES_ENC_KEY`, la misma en ambas Lambdas). El cerebro descifra solo
  al momento de responder a las cuentas de soporte autorizadas. Si se pierde la clave, hay que
  volver a cargar los Excels. Datos cargados antes del cifrado siguen siendo legibles
  (compatibilidad), pero conviene recargarlos para que queden cifrados.
- Este sistema devuelve contraseñas por correo — úsalo solo con las 4 cuentas de soporte
  autorizadas para el piloto, y evalúa a futuro un flujo de reseteo en vez de consulta directa.
- Las Function URLs del piloto están sin autenticación (`--auth-type NONE`, ver `docs/SETUP_AWS.md`)
  — aceptable para el piloto porque la URL es larga y no se publica, pero antes de producción real
  conviene `AWS_IAM` o un secreto compartido validado en el propio handler.
- Ningún `.env` se commitea (ver `.gitignore`); las variables sensibles en AWS viven en SSM Parameter
  Store o directamente en la configuración de la Lambda.
- El paquete `xlsx` (SheetJS) tiene una vulnerabilidad conocida sin fix disponible en npm (prototype
  pollution / ReDoS) — el riesgo es acotado porque solo procesa archivos subidos por administradores
  del sistema, no contenido de internet arbitrario.

## Pendientes / configuración que falta del lado del negocio

- **Lista real de correos de los agentes digitales de servicio** → variable `AGENTES_DIGITALES` de
  la Lambda `cerebro-sac` (separados por coma; asignación round-robin).
- Credenciales del Jira externo (integración en standby).
- Decisión sobre la migración de Mongo a AWS (ver `docs/MIGRACION_MONGO_AWS.md`).
