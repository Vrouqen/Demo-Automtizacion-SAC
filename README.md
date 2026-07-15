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
n8n flujo 1: Outlook Trigger → filtra respuestas de agentes (asunto con "CASO-") → arma payload
        ↓
n8n: HTTP Request → apps/cerebro (AWS Lambda, Function URL)
        ↓
cerebro: Gemini + function calling decide la intención:
  - buscar_credenciales          → busca en Mongo (fuzzy match colegio + estudiante,
                                    con región/ciudad/cantón para separar colegios HOMÓNIMOS)
  - derivar_a_agente_digital     → crea un caso [CASO-XXXXXX] y lo asigna (round-robin) a un
                                    agente digital de servicio (lista en AGENTES_DIGITALES)
  - consultar_estudiantes_activos → estudiantes activos de un colegio (activo = tiene credenciales)
  - crear_ticket                 → registra el ticket en Mongo (Jira real en standby)
  - info_pin                     → mini tutorial de dónde está el PIN (impreso en el reverso del
                                    libro "Compartir"; no tiene relación con las credenciales
                                    cargadas por Excel)
  - fuera_de_alcance             → respuesta fija de cortesía
        ↓
n8n Switch según "accion":
  - responder                → contesta el correo en el MISMO HILO (conversationId de Graph)
  - responder_y_crear_ticket → ídem (nodo Jira se conecta aquí cuando salga de standby)
  - escalar                  → envía el correo de DELEGACIÓN al agente digital + avisa al cliente
                               en su mismo hilo que un digital de servicio atenderá su caso

n8n flujo 2 (workflow-respuesta-agente.json): cuando el agente digital responde el correo de
delegación (manteniendo [CASO-XXXXXX] en el asunto), el cerebro recupera el hilo ORIGINAL del
cliente desde Mongo y n8n le responde ahí — la solución llega por el mismo hilo del correo inicial.
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
  workflow-soporte-correo.json    # Flujo 1: correo del cliente → cerebro → respuesta/escalamiento
  workflow-respuesta-agente.json  # Flujo 2: respuesta del agente digital → hilo original del cliente
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

**`POST /?accion=respuesta_agente`** — body `{ asunto, respuesta, correoAgente }` (o `codigo`
explícito). Extrae el `CASO-XXXXXX` del asunto, marca el caso resuelto y devuelve
`{ hiloId, mensajeId, textoRespuesta }` del correo **original** del cliente, para responderle en su
mismo hilo (lo usa el flujo 2 de n8n).

**`GET /?reporte=analitica`** — resumen agregado: tickets por tipo/estado, eventos por tipo (incluye
escalamientos), total de conversaciones.

**`GET /?reporte=estudiantes_activos&idColegio=<id Pegasus>`** — cantidad de estudiantes activos del
colegio (**activo = tiene credenciales cargadas**, es decir login y contraseña), con desglose por
plataforma (Compartir/CREO).

### Funciones que maneja el LLM

- **Credenciales de estudiante**: pide nombre completo, nivel, paralelo, colegio, ciudad (provincia)
  y cantón. Tolera nombres incompletos en la base y nombres de colegio aproximados mediante
  coincidencia difusa propia (`utils/similitud.js`). Manejo de **colegios homónimos**: si dos o más
  colegios tienen nombre igual o muy parecido, no adivina — muestra las opciones con su ciudad y
  cantón para que el remitente confirme cuál es.
- **Colegio no encontrado (flujo de escalamiento)**: primero muestra sugerencias; si no sirven,
  pregunta si la institución se conoce por **algún otro nombre**; si el usuario da otro nombre,
  vuelve a buscar; solo si dice que no (o la segunda búsqueda también falla) **deriva el caso a un
  agente digital de servicio**: se le envía un correo de delegación con el código `[CASO-XXXXXX]` y
  al cliente se le avisa en su mismo hilo. Cuando el agente responde, su respuesta vuelve al cliente
  **por el hilo del correo inicial** (flujo 2 de n8n).
- **Estudiantes activos**: consulta por id de Pegasus o nombre de colegio cuántos estudiantes
  activos tiene (activo = con credenciales cargadas).
- **Reseteo de contraseña**: **siempre** genera un ticket (nunca lo resuelve el LLM directamente).
- **PIN de acceso**: toda consulta se responde con un **mini tutorial** de dónde encontrarlo (está
  impreso en el reverso del libro "Compartir"). Es el PIN del libro físico — no tiene relación con
  las credenciales que se cargan por Excel. No hay forma automática de validar un PIN.
- **Incidencias de plataforma**: genera un ticket para el equipo de servicio digital.
- **Fuera de alcance**: responde amablemente que no aplica.

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
