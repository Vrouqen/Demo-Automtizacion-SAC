# Guía de configuración de n8n (correo Outlook empresarial → cerebro Lambda)

## 1. Registrar la app en Microsoft Entra ID (Azure AD) — requiere un admin del tenant

Esto lo debe hacer alguien con rol de **Administrador global** o **Administrador de aplicaciones**
en el Microsoft 365 de la empresa. Es un paso único, gratuito.

1. Entra a [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **Registros de
   aplicaciones** → **Nuevo registro**.
   - Nombre: `n8n-soporte-santillana`
   - Tipos de cuenta admitidos: *Cuentas solo en este directorio organizativo* (single-tenant)
   - URI de redirección: tipo **Web**, pega la URL de callback que te muestra n8n al crear la
     credencial (paso 3) — normalmente `https://TU-N8N/rest/oauth2-credential/callback`.
2. Copia el **Application (client) ID** y el **Directory (tenant) ID** que aparecen en la página de
   la app recién creada.
3. **Certificados y secretos** → **Nuevo secreto de cliente** → copia el **valor** inmediatamente (solo
   se muestra una vez).
4. **Permisos de API** → **Agregar un permiso** → **Microsoft Graph** → **Permisos delegados** →
   agrega: `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `offline_access`, `User.Read`.
5. Click en **Conceder consentimiento de administrador para [tenant]** — este botón solo lo puede
   pulsar un admin del tenant. Sin este paso, el login OAuth2 falla con un error de permisos.

## 2. Las 4 cuentas de soporte como buzones compartidos (gratis, sin licencia)

Si aún no existen, pide a TI que las cree como **buzones compartidos** (Centro de administración de
Microsoft 365 → Buzones compartidos), no como usuarios con licencia — no tienen costo de licencia.

Los buzones compartidos no tienen contraseña propia ni login interactivo, así que el acceso se hace
por **delegación**: una cuenta con licencia (puede ser tu propia cuenta o una cuenta de servicio) debe
tener permiso **Acceso completo (Full Access)** y **Enviar como (Send As)** sobre cada uno de los 4
buzones. Pide a TI que otorgue esos permisos:

```powershell
# Ejecutado por TI en PowerShell de Exchange Online, una vez por buzón:
Add-MailboxPermission -Identity "soporte1@empresa.com" -User "cuenta.servicio@empresa.com" -AccessRights FullAccess
Add-RecipientPermission -Identity "soporte1@empresa.com" -Trustee "cuenta.servicio@empresa.com" -AccessRights SendAs
```

## 3. Crear la credencial en n8n

**Credentials → New → "Microsoft Outlook OAuth2 API"** (o "Microsoft OAuth2 (Graph)" si tu versión de
n8n la agrupa así):
- Client ID / Client Secret: los del paso 1.
- Tenant: el Directory (tenant) ID del paso 1 (no dejes "common" si el registro es single-tenant).
- Conecta e inicia sesión con la **cuenta de servicio con delegación** del paso 2 (no con el buzón
  compartido directamente, ya que no tiene login propio).

En el nodo de Outlook (trigger y el de responder), busca la opción para apuntar a un buzón distinto al
de la cuenta autenticada (suele aparecer como "Buzón"/"Mailbox" o un parámetro de usuario) y ponla en
`soporte1@empresa.com` (y su par en cada rama, para las otras 3 cuentas). Esto varía un poco según la
versión de n8n — si no la ves, dínoslo y ajustamos.

## 4. El workflow principal (flujo 1: correo del cliente)

Se incluye `n8n/workflow-soporte-correo.json` como **punto de partida** — impórtalo
(**Workflows → Import from File**) y revisa el mapeo de campos tras importarlo, ya que algunos nombres
de parámetros pueden variar entre versiones de n8n.

```
[Outlook Trigger] ──► [IF: asunto NO contiene "CASO-"] ──► [Code: armar payload] ──► [HTTP → cerebro]
                                                                                          │
                                                                             [Switch: accion]
                                                             ┌────────────────────┼───────────────┐
                                                        "escalar"    "responder_y_crear_ticket"  resto
                                                             │                    │               │
                                          [Outlook: Send delegación a agente]    │               │
                                                             └──────────────► [Outlook: Reply (mismo hilo)]
```

- El **IF inicial** descarta los correos cuyo asunto contiene `CASO-`: esos son respuestas de los
  agentes digitales a casos escalados y los procesa el **flujo 2** (abajo). Sin este filtro, el
  cerebro trataría la respuesta del agente como una consulta nueva.
- La rama **escalar** del Switch primero envía el correo de delegación al agente digital y luego
  responde al cliente (el `textoRespuesta` del cerebro ya le avisa que un digital de servicio
  atenderá su caso, con el código `CASO-XXXXXX`).

El JSON exportado trae **un** trigger de ejemplo — duplícalo 3 veces (clic derecho → Duplicate) y
cambia el buzón de cada copia para cubrir las 4 cuentas; todas conectan al mismo nodo "IF".

### Nodo "Code: armar payload"

Construye el body que espera el cerebro. Lo importante:

- **`hiloId` = `conversationId`** del mensaje de Outlook/Graph — Graph agrupa automáticamente todos
  los correos de un mismo hilo bajo ese campo, así que no hace falta armar el threading a mano con
  `Message-ID`/`References` como en IMAP puro.
- `adjuntos`: por ahora puedes dejarlo como `[]` — la app de correo aún no reenvía el contenido de los
  adjuntos al cerebro (eso se conecta cuando Jira salga de standby, ver nota más abajo).

```js
return [{
  json: {
    hiloId: $json.conversationId,
    mensajeId: $json.id,
    remitente: $json.from.emailAddress.address,
    cuentaSoporte: $json.toRecipients?.[0]?.emailAddress?.address ?? '',
    asunto: $json.subject,
    cuerpo: $json.body.content,
    adjuntos: [],
  },
}];
```

### Nodo "HTTP Request → cerebro"

- Método: `POST`
- URL: la Function URL de `cerebro-sac` (ver `docs/SETUP_AWS.md`)
- Body: JSON, `{{ $json }}` (pasa el objeto completo del nodo anterior)

### Nodo "Switch"

Rama según `{{ $json.accion }}` (el cerebro devuelve `"responder"` o `"responder_y_crear_ticket"` —
por ahora, con Jira en standby, ambas ramas terminan igual: responder el correo. Cuando Jira se
active, la rama `responder_y_crear_ticket` es donde se agrega el nodo nativo de Jira de n8n).

### Nodo "Outlook: Reply"

- Resource: `Message`, Operation: `Reply`
- Message ID: `{{ $('Code: armar payload').item.json.mensajeId }}` (esto es lo que hace que la
  respuesta caiga en el mismo hilo)
- Comentario/cuerpo: `{{ $('HTTP Request → cerebro').item.json.textoRespuesta }}`

### Nodo "Outlook: Enviar delegación a agente" (rama escalar)

- Resource: `Message`, Operation: `Send`
- To: `{{ $('HTTP Request -> cerebro').item.json.escalamiento.correoDelegacion.para }}`
- Subject: `{{ ...escalamiento.correoDelegacion.asunto }}` (ya incluye `[CASO-XXXXXX]`)
- Body: `{{ ...escalamiento.correoDelegacion.cuerpo }}` (ya incluye la instrucción al agente de
  responder manteniendo el código en el asunto)

La lista de correos de los agentes vive en la variable de entorno `AGENTES_DIGITALES` de la Lambda
`cerebro-sac` (ver `docs/SETUP_AWS.md`, paso 6) — el cerebro asigna cada caso en round-robin.
**Cuando tengan la lista real de correos de los digitales de servicio, solo hay que actualizar esa
variable; n8n no cambia.**

## 5. Flujo 2: respuesta del agente digital → cliente (mismo hilo original)

Importa `n8n/workflow-respuesta-agente.json`. Este flujo cierra el círculo del escalamiento:

```
[Outlook Trigger (mismo buzón)] ──► [IF: asunto contiene "CASO-"] ──► [Code: payload]
        ──► [HTTP POST cerebro?accion=respuesta_agente] ──► [IF: status OK]
        ──► [Outlook: Reply al cliente sobre el mensajeId ORIGINAL]
```

Cómo funciona el retorno por el hilo inicial:

1. Al escalar, el cerebro guardó en Mongo (colección `escalamientos`) el `hiloId` y el `mensajeId`
   del correo original del cliente, bajo el código `CASO-XXXXXX`.
2. El agente responde al correo de delegación; como mantiene `[CASO-XXXXXX]` en el asunto, este
   flujo lo detecta.
3. El endpoint `?accion=respuesta_agente` extrae el código del asunto, marca el caso como resuelto y
   devuelve `{ hiloId, mensajeId, textoRespuesta }` — donde `mensajeId` es el del correo **original
   del cliente**.
4. El nodo final hace Reply sobre ese `mensajeId`: la respuesta del agente le llega al cliente **en
   el mismo hilo** donde escribió al principio.

> Si el agente responde SIN el código en el asunto, el flujo no lo detecta (queda en la salida false
> del IF). El correo de delegación se lo advierte explícitamente; aun así conviene revisar
> ocasionalmente los casos `pendiente_agente` en la colección `escalamientos`.

## 6. Jira — placeholder para cuando salga de standby

El cerebro ya deja todo listo del lado de datos (cada ticket queda en Mongo con `estado:
"pendiente_jira"` y, si aplica, `enlazadoA: "<jiraKey del ticket anterior del mismo hilo>"`). Cuando
tengan las credenciales del Jira externo:

1. Agrega un nodo **Jira** de n8n después del Switch, rama `responder_y_crear_ticket`, usando los
   campos que devuelve el cerebro (`ticket.tipo`, `ticket.equipo`, `ticket.descripcion`).
2. Si `ticket.enlazadoA` no es `null`, agrega también el nodo Jira de "Link Issue" (`relates to`)
   contra ese ticket anterior.
3. Para el cierre automático (correo de vuelta cuando el ticket se resuelve): añade un segundo
   flujo con un **Jira Trigger** (si el Jira externo permite webhooks salientes) o un **Schedule
   Trigger** que haga polling del estado cada cierto tiempo, y termine con otro nodo Outlook Reply
   sobre el mismo `hiloId`/`mensajeId` guardado en Mongo.

## 7. Analítica y reportes

- `GET {URL-CEREBRO}/?reporte=analitica` — resumen agregado (tickets por tipo/estado, eventos por
  tipo — incluidos `escalado_a_agente` y `respuesta_agente_entregada` —, total de conversaciones).
- `GET {URL-CEREBRO}/?reporte=estudiantes_activos&idColegio=<id Pegasus>` — cantidad de estudiantes
  activos de un colegio (activo = tiene PIN asociado), con desglose por plataforma (Compartir/CREO).

Puedes armar un nodo HTTP Request + Schedule Trigger en n8n para traer cualquiera de los dos
periódicamente a una hoja de Google Sheets o a un dashboard, sin tocar el cerebro.
