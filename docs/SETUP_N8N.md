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

## 4. El workflow

Se incluye `n8n/workflow-soporte-correo.json` como **punto de partida** — impórtalo
(**Workflows → Import from File**) y revisa el mapeo de campos tras importarlo, ya que algunos nombres
de parámetros pueden variar entre versiones de n8n.

```
[Outlook Trigger: soporte1@empresa.com] ─┐
[Outlook Trigger: soporte2@empresa.com] ─┤
[Outlook Trigger: soporte3@empresa.com] ─┼──► [Code: armar payload] ──► [HTTP Request → cerebro]
[Outlook Trigger: soporte4@empresa.com] ─┘                                        │
                                                                                    ▼
                                                                     [Switch: accion == "responder"?]
                                                                                    │
                                                                                    ▼
                                                          [Outlook: Reply (mismo hilo)]
```

El JSON exportado trae **un** trigger de ejemplo — duplícalo 3 veces (clic derecho → Duplicate) y
cambia el buzón de cada copia para cubrir las 4 cuentas; todas conectan al mismo nodo "Code".

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

## 5. Jira — placeholder para cuando salga de standby

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

## 6. Analítica

`GET {URL-CEREBRO}/?reporte=analitica` devuelve un resumen agregado (tickets por tipo/estado, eventos
por tipo, total de conversaciones) — puedes armar un nodo HTTP Request + Schedule Trigger en n8n para
traerlo periódicamente a una hoja de Google Sheets o a un dashboard, sin tocar el cerebro.
