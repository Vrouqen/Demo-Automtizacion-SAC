# Demo Automatización SAC — Piloto de soporte por correo

Piloto de un asistente de soporte de Santillana Ecuador que atiende por **correo electrónico**
(Outlook empresarial), usando **Google Gemini 1.5 Flash** (gratuito, Google AI Studio) con function
calling para consultar credenciales de estudiantes en MongoDB Atlas, resolver dudas de PIN, y
generar tickets (Jira externo, **actualmente en standby**).

> Migrado desde una versión anterior por WhatsApp/Anthropic (`git log` conserva ese historial).
> Todo lo desplegado en este piloto usa exclusivamente capas gratuitas — ver el desglose de costos
> en `docs/SETUP_AWS.md`.

## Arquitectura

```
Correo entrante (4 buzones compartidos de soporte, Outlook 365)
        ↓
n8n: Outlook Trigger (Microsoft Graph, OAuth2) arma el payload del correo
        ↓
n8n: HTTP Request → apps/cerebro (AWS Lambda, Function URL)
        ↓
cerebro: Gemini 1.5 Flash + function calling decide la intención:
  - buscar_credenciales   → apps/cerebro busca en Mongo (fuzzy match colegio + estudiante)
  - crear_ticket          → registra el ticket en Mongo (estado "pendiente_jira", enlazado
                             al ticket anterior del mismo hilo si existe — Jira real en standby)
  - info_pin              → respuesta fija (reverso del libro "Compartir")
  - fuera_de_alcance      → respuesta fija de cortesía
        ↓
n8n: responde el correo en el MISMO HILO (usa el conversationId de Outlook/Graph)
```

Cada conversación (hilo de correo) y cada evento/ticket queda registrado en Mongo Atlas
(colección `conversaciones`) — es la fuente de la analítica del piloto
(`GET /?reporte=analitica` en el cerebro).

## Estructura del repo (monorepo)

```
apps/
  cerebro/               # Lambda: Gemini + Mongo + analítica + tickets (stub Jira)
  carga-credenciales/     # Lambda: sube un Excel de credenciales a Mongo Atlas
docs/
  SETUP_AWS.md            # Guía paso a paso: ECR, Lambda, Function URL, SSM Parameter Store
  SETUP_N8N.md             # Guía paso a paso: Azure AD, buzones compartidos, workflow de n8n
n8n/
  workflow-soporte-correo.json  # Workflow de n8n exportable (punto de partida)
```

Cada app en `apps/` es un Lambda independiente (imagen Docker) con su propio `package.json` — no
comparten `node_modules`. Instala y prueba cada una por separado:

```bash
cd apps/cerebro && npm install && cp .env.example .env   # completa MONGODB_URI y GEMINI_API_KEY
cd apps/carga-credenciales && npm install && cp .env.example .env
```

## Despliegue

Ver **`docs/SETUP_AWS.md`** (AWS: ECR, Lambda como imagen de contenedor, Function URL, variables en
SSM Parameter Store) y **`docs/SETUP_N8N.md`** (registro de app en Microsoft Entra ID, buzones
compartidos de Outlook, workflow de n8n con threading por `conversationId`).

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
Responde: `{ hiloId, textoRespuesta, ticket }` (`ticket` viene poblado solo si se generó uno).

**`GET /?reporte=analitica`** — resumen agregado: tickets por tipo/estado, eventos por tipo, total de
conversaciones.

### Funciones que maneja el LLM

- **Credenciales de estudiante**: pide nombre completo, nivel, paralelo, colegio y provincia. Tolera
  nombres incompletos en la base (ej. un nombre y un apellido) y nombres de colegio aproximados
  mediante coincidencia difusa propia (sin dependencias externas, `utils/similitud.js`). Si no
  encuentra el colegio, devuelve sugerencias (nombre + provincia) para que el remitente confirme al
  responder el mismo correo; si no encuentra al estudiante, lo notifica.
- **Reseteo de contraseña**: **siempre** genera un ticket (nunca lo resuelve el LLM directamente).
- **PIN de acceso**: respuesta fija (reverso del libro "Compartir"); si el PIN no funciona, indica que
  aún no hay validación automática para ese caso.
- **Incidencias de plataforma** ("no veo contenido", "no veo mis clases"): genera un ticket para el
  equipo de servicio digital.
- **Fuera de alcance**: responde amablemente que no aplica.

### Tickets y enlazado (Jira en standby)

Cuando un hilo ya tiene un ticket y el usuario reporta *otro* problema distinto en el mismo hilo, el
sistema **no reutiliza ni reabre** el ticket anterior — crea uno nuevo y lo enlaza al anterior
(`enlazadoA`). Esto evita mezclar categorías/equipos distintos en un mismo ticket de Jira y mantiene
correctas las métricas de tiempo de resolución. La trazabilidad de "todo lo que pasó en este hilo" la
lleva la propia colección `conversaciones`, no Jira.

Jira real está desactivado por defecto (`JIRA_HABILITADO=false`): los tickets quedan en Mongo con
`estado: "pendiente_jira"`, listos para cuando se conecte la integración real (ver el `TODO` en
`apps/cerebro/src/services/tickets.js`).

## `apps/carga-credenciales`

Sube un Excel de credenciales (pestañas **Docentes** y/o **Estudiantes**) a Mongo Atlas.

**`POST /`** — body JSON:
```json
{
  "idColegio": "COL-001",
  "codigoColegio": "UE-QUITO-01",
  "nombreColegio": "Unidad Educativa San Francisco de Quito",
  "provincia": "Pichincha",
  "nombreArchivo": "credenciales.xlsx",
  "archivoBase64": "<contenido del .xlsx en base64>"
}
```
`provincia` es opcional (si falta, se guarda `n/a`). Columnas del Excel esperadas (el orden no
importa, se detectan por nombre): `Grado | Grupo | Apellido Paterno | Apellido Materno | Nombre |
Login | Contraseña`.

**`GET /?listar=1`** — lista los colegios cargados (sin credenciales).

## Seguridad

- Este sistema devuelve contraseñas en texto plano por correo — úsalo solo con las 4 cuentas de
  soporte autorizadas para el piloto, y evalúa a futuro un flujo de reseteo en vez de consulta directa.
- Las Function URLs del piloto están sin autenticación (`--auth-type NONE`, ver `docs/SETUP_AWS.md`)
  — aceptable para el piloto porque la URL es larga y no se publica, pero antes de producción real
  conviene `AWS_IAM` o un secreto compartido validado en el propio handler.
- Ningún `.env` se commitea (ver `.gitignore`); las variables sensibles en AWS viven en SSM Parameter
  Store, no en Secrets Manager (que tiene costo) ni en texto plano en el código.
- El paquete `xlsx` (SheetJS) tiene una vulnerabilidad conocida sin fix disponible en npm (prototype
  pollution / ReDoS) — el riesgo es acotado porque solo procesa archivos subidos por administradores
  del sistema, no contenido de internet arbitrario.
