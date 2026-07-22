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

## 4. El workflow (uno solo)

Se incluye `n8n/workflow-soporte-correo.json` — impórtalo (**Workflows → Import from File**) y revisa
el mapeo de campos tras importarlo, ya que algunos nombres de parámetros pueden variar entre
versiones de n8n.

> **Cambio importante respecto a versiones anteriores:** antes había *dos* workflows y el segundo
> detectaba las respuestas de los agentes buscando la palabra `CASO-` en el asunto. Eso era frágil
> (dos triggers sobre el mismo buzón, y el propio correo de delegación también lleva `CASO-` en el
> asunto). **Ahora hay un solo workflow** y las respuestas de los agentes se reconocen por el
> `conversationId` del hilo de delegación, guardado en Mongo. Si tenías importado
> `workflow-respuesta-agente.json`, **elimínalo de n8n**: ya no existe.

```
[Outlook Trigger] ─► [Code: armar payload] ─► [HTTP → cerebro] ─► [Switch: accion]
                                                                        │
        ┌──────────────────┬──────────────────┬──────────────────┬──────┴──────┐
   "escalar"          "crear_ticket"      "ignorar"                        "responder"
        │                  │                  │                                 │
 [Send delegación]  [Avisar ticket      [mover a Correo                         │
        │            al equipo]          no deseado]                            │
 [registrar hilo    [registrar hilo                                            │
  de delegación]     ticket]                                                    │
        │                  │                          [IF: hay mensaje al que responder]
        └──────────────────┴──────────────────────────────► [Outlook: Reply] ◄─┘
```

Las ramas **escalar** (caso) y **crear_ticket** son gemelas: ambas avisan a una persona, registran el
`conversationId` de ese aviso, y responden al cliente. Ese registro es lo que hace el **viaje de
vuelta**: cuando la persona responde a su aviso, el cerebro reenvía su respuesta al hilo original del
cliente.

**Todos** los correos del buzón entran por el mismo trigger: consultas de clientes y respuestas de
agentes. El cerebro distingue unas de otras y devuelve en `mensajeIdRespuesta` a qué correo hay que
responder, así que basta **un solo nodo Reply**.

Si usan varias cuentas de soporte, duplica el trigger (clic derecho → Duplicate) y cambia el buzón de
cada copia; todas conectan al mismo nodo "Code".

### ⚠️ Anti-bucle: configura `CUENTAS_SOPORTE` y vigila SOLO la Bandeja de entrada

El sistema envía correos (respuesta al cliente, aviso de ticket a un equipo, delegación a un agente)
**desde el buzón de soporte**. Si alguno de esos correos vuelve a entrar por el trigger, el sistema
lo tomaría por una consulta nueva y **se respondería a sí mismo en bucle** — que es justo lo que pasó
con los avisos de ticket.

Dos capas de defensa, pon las dos:

1. **En el Outlook Trigger, vigila solo la carpeta *Bandeja de entrada*** (Inbox), nunca *Elementos
   enviados*. Así los correos que enviamos no se vuelven a levantar. Si tu versión de n8n no deja
   elegir carpeta y levanta también los enviados, la capa 2 lo cubre igual.
2. **Define `CUENTAS_SOPORTE`** en la Lambda `cerebro-sac`: la lista de las direcciones de tus buzones
   de soporte (las que vigila n8n), separadas por coma. El cerebro descarta cualquier correo cuyo
   remitente sea una de ellas — es nuestro propio envío. Esta capa atrapa incluso el aviso de ticket,
   que va dirigido a un agente (su `to` **no** es la cuenta de soporte, así que la comparación normal
   no bastaba).

   ```
   CUENTAS_SOPORTE = asistentedigitaltee@outlook.com
   ```
   Con varios buzones, sepáralos por coma. Si la dejas vacía, el arranque de la Lambda avisa en los
   logs (`CUENTAS_SOPORTE está vacía`).

### Nodo "Outlook Trigger": APAGA *Simplify*

> ⚠️ **Es obligatorio.** Con *Simplify* encendido, Graph no envía `body.content` y solo queda
> `bodyPreview`, **cortado a ~255 caracteres**. El asistente no llega a leer el final del correo, así
> que vuelve a pedir datos que el usuario sí escribió y la conversación entra en bucle. Fue
> exactamente la causa de que, tras recibir la lista completa de datos del estudiante, el asistente
> volviera a pedir cantón, usuario y fecha.
>
> El sistema ya no falla en silencio: si detecta que solo llegó el preview, marca `cuerpoTruncado`,
> avisa al modelo de que el correo puede venir cortado y lo registra como evento `correo_truncado`,
> que aparece en el dashboard bajo *Correos que llegaron cortados*. Pero la solución real es apagar
> el toggle.

### Nodo "Code: armar payload"

Construye el body que espera el cerebro:

- **`hiloId` = `conversationId`** del mensaje de Outlook/Graph — Graph agrupa automáticamente todos
  los correos de un mismo hilo bajo ese campo.
- Descarta correos sin remitente real, los que llegan sin `id` (no habría a qué responder) y los
  enviados por la propia cuenta de soporte (evita bucles).
- Marca `cuerpoTruncado` cuando solo llegó el preview (ver el aviso de arriba).

### Nodo "HTTP Request → cerebro"

- Método `POST`, URL = la Function URL de `cerebro-sac` (ver `docs/SETUP_AWS.md`).
- Body JSON: `{{ JSON.stringify($json) }}`.
- Tiene `retryOnFail` porque el cerebro devuelve **503** cuando la IA no está disponible (cuota
  agotada): en ese caso no respondió nada y el correo debe reintentarse.

### Nodo "Switch: accion"

| `accion` | Qué hace |
|---|---|
| `escalar` | Envía la delegación al **agente digital**, registra el hilo, y responde al cliente |
| `ignorar` | Correo basura: lo mueve a *Correo no deseado* y **no responde** |
| `responder_y_crear_ticket` | Avisa por correo al **equipo** (Cuentas / Servicio Digital) y responde al cliente |
| `responder` / `responder_al_cliente` | Responde directo |
| `ninguna` / `error_temporal` | No responde nada (duplicado, correo propio, o IA caída) |

> El Switch entrega al **primer** output que casa, por eso `responder` (la regla amplia "todo lo que
> no sea…") va la última. Si se pone antes, se traga `responder_y_crear_ticket` y el equipo nunca
> recibe el aviso — fue exactamente el fallo de "el ticket no le llega a nadie".

### Ticket ≠ Caso — son dos caminos distintos hacia una persona

Confundirlos hace perder mucho tiempo depurando:

| | **Ticket** (`responder_y_crear_ticket`) | **Caso** (`escalar`) |
|---|---|---|
| Cuándo | Reseteo de clave, incidencia de plataforma | El asistente no pudo resolverlo |
| Quién lo atiende | Un **equipo**: Cuentas o Servicio Digital | Un **agente digital** concreto |
| Cómo llega | `Outlook: Avisar ticket al equipo` | `Outlook: Enviar delegación a agente` |
| Su respuesta | La escribe el equipo al cliente, por su cuenta | Vuelve **automáticamente** al hilo del cliente |
| En el JSON | `ticket: {...}`, `escalamiento: null` | `escalamiento: {...}` |

Si ves `"escalamiento": null` y `"accion": "responder_y_crear_ticket"`, **no hay ningún caso que
derivar**: es un ticket, y quien debe recibirlo es el equipo, no un agente digital.

> **Un ticket genera dos correos, y eso es correcto:** al **cliente** un acuse breve en su hilo
> ("Recibimos tu solicitud, te responderemos por este mismo correo" — **sin** el código interno), y
> al **equipo** (nodo *Avisar ticket al equipo*) el aviso con todos los datos. No es un duplicado:
> uno es el acuse al cliente, el otro la orden de trabajo.
>
> **El ticket ahora hace VIAJE DE VUELTA, igual que un caso.** Cuando el equipo (o el agente)
> responde al aviso, el cerebro reconoce esa respuesta por el `conversationId` del aviso —registrado
> por el nodo *HTTP: registrar hilo ticket*— y la reenvía sola al hilo original del cliente. Antes no
> existía ese camino: la respuesta del equipo se perdía y el sistema la malinterpretaba como una
> consulta nueva ("tu mensaje parece incompleto"). Por eso la rama de ticket tiene el mismo `registrar
> hilo` que la de escalar.
>
> Si no configuras `CORREO_EQUIPO_CUENTAS` / `CORREO_EQUIPO_SERVICIO_DIGITAL`, el aviso interno cae en
> `AGENTES_DIGITALES` como respaldo — por eso te llegaba a ti (el agente). Pon los buzones de los
> equipos reales para que vaya a donde debe.

> **Los correos internos salían con las etiquetas `<div>` a la vista:** era porque el nodo de Outlook
> enviaba el HTML como texto plano. Ya está corregido con `bodyContentType = html` en los tres nodos
> que envían contenido (Reply, delegación y aviso de ticket). Si tras reimportar vuelves a verlo,
> revisa que esos nodos tengan *Additional Fields → Body Content Type = HTML*.

`responder_al_cliente` es la respuesta de un agente devuelta al hilo original del cliente — no
necesita rama propia porque el `mensajeIdRespuesta` ya viene resuelto por el cerebro.

### Rama "ignorar": limpieza de correos basura

El cerebro clasifica cada correo entrante **antes** de llamar a la IA (`utils/clasificacion.js`) y
devuelve `accion: "ignorar"` cuando detecta:

| Categoría | Ejemplo |
|---|---|
| `promocional` | Publicidad y newsletters ("Azure for Students", ofertas, webinars) |
| `remitente_automatico` | `noreply@`, `notificaciones@`, `marketing@`, `postmaster@`… |
| `envio_masivo` | Dominios de plataformas de mailing (Mailchimp, SendGrid, Marketo…) |
| `respuesta_automatica` | "Respuesta automática", "Out of office" |
| `rebote` | "Undeliverable", "Delivery has failed" |

El filtro es deliberadamente conservador: descarta con una señal fuerte (remitente automático,
rebote, aviso de ausencia) o con **dos** señales de publicidad, y **nunca** si el texto contiene una
intención de soporte clara (credenciales, contraseña, PIN, colegio, estudiante…). Ante la duda,
atiende el correo. Cada descarte se registra en los logs de la Lambda (`[basura] categoría: señal`)
para poder afinarlo.

El nodo **Outlook: mover a Correo no deseado** usa Operation `Move` con la carpeta `junkemail`
(nombre bien conocido de Graph). Sacarlo de la bandeja de entrada evita además que el trigger lo
vuelva a levantar. Si el buzón usa otra carpeta, selecciónala con el desplegable del nodo.

### Nodos "IF: hay mensaje al que responder" y "Outlook: Reply (mismo hilo)"

- IF: comprueba que el id del mensaje no venga vacío. Graph devuelve
  `400 ErrorInvalidIdMalformed` ("Id is malformed") cuando el Message ID llega vacío o mal formado,
  y ese error se ve como un fallo de Outlook cuando en realidad es un dato ausente aguas arriba.
- Reply: Resource `Message`, Operation `Reply`
- Message ID: `{{ $('HTTP Request -> cerebro').item.json.mensajeIdRespuesta || $('Code: armar payload').item.json.mensajeId }}`
  — el respaldo cubre el caso de que el cerebro no lo devuelva (p. ej. porque el trigger no envió el
  `id` del correo).
- Cuerpo: `{{ $('HTTP Request -> cerebro').item.json.textoRespuestaHtml ?? ...textoRespuesta }}`
  (el campo HTML es el que hace que los saltos de línea y las listas se vean bien en Outlook).

> **Si vuelve a aparecer "Id is malformed"**, mira el JSON de salida del nodo `HTTP Request →
> cerebro`: si `mensajeIdRespuesta` viene `null`, el problema está en el trigger (no entregó `id`),
> no en el nodo de Outlook.

### Nodos de la rama "escalar"

1. **Outlook: Enviar delegación a agente** — Send, con `escalamiento.correoDelegacion.para` /
   `.asunto` / `.cuerpoHtml`. El asunto trae `[CASO-XXXXXX] Motivo — resumen corto`, y el cuerpo
   lleva el caso documentado por secciones (qué necesita el usuario, datos del estudiante, datos de
   la institución, qué se intentó).
2. **HTTP: registrar hilo de delegación** — `POST {URL-CEREBRO}/?accion=registrar_delegacion` con
   `{ codigo, conversationIdDelegacion, mensajeIdDelegacion }`. **Este es el paso clave del
   enrutado**: guarda el hilo del correo recién enviado para reconocer después la respuesta del
   agente. Está configurado con *continue on error*: si falla, el sistema aún funciona por el
   respaldo del código en el asunto.

La lista de correos de los agentes vive en la variable de entorno `AGENTES_DIGITALES` de la Lambda
`cerebro-sac` (ver `docs/SETUP_AWS.md`, paso 6) — el cerebro asigna cada caso **al agente con menos
casos abiertos**. **Cuando tengan la lista real de los digitales de servicio, solo hay que actualizar
esa variable; n8n no cambia.**

> **Si el caso se crea pero el agente no recibe nada**, revisa en este orden:
> 1. `AGENTES_DIGITALES` está definida y no vacía en la Lambda. Sin ella la creación del caso falla;
>    desde esta versión eso devuelve **503 y no se responde nada al usuario** (antes el usuario
>    recibía un "le atenderá un agente digital" y el caso no existía).
> 2. La salida del nodo `HTTP Request → cerebro` trae `accion: "escalar"`. Si trae `"responder"`, el
>    caso no llegó a crearse: mira los logs de CloudWatch, sale como `[escalamiento] no se pudo crear`.
> 3. El nodo *Outlook: Enviar delegación a agente* tiene credenciales válidas.
>
> El dashboard muestra estos fallos en *Salud del sistema → Escalamientos que fallaron*.

## 5. Cómo vuelve la respuesta del agente al cliente

1. Al escalar, el cerebro guarda en Mongo (colección `escalamientos`) el `hiloId` y el `mensajeId`
   del correo **original del cliente**, bajo el código `CASO-XXXXXX`.
2. n8n envía la delegación y registra el `conversationId` de ese correo nuevo.
3. El agente responde a la delegación. Ese correo entra por el **mismo trigger** que todo lo demás.
4. El cerebro ve que el `conversationId` entrante corresponde a un hilo de delegación pendiente →
   marca el caso como resuelto y devuelve `mensajeIdRespuesta` = el del correo **original del
   cliente**, junto con la respuesta del agente ya limpia (sin el correo de delegación citado).
5. El nodo Reply responde ahí: la solución le llega al cliente **en el hilo donde escribió**.

Ventaja frente al esquema anterior: **el agente puede cambiar el asunto por completo** y el sistema
lo sigue reconociendo. El código en el asunto queda solo para lectura humana y como respaldo (ese
respaldo, además, solo acepta el correo si viene de una dirección de `AGENTES_DIGITALES`).

> Para revisar casos que quedaron sin respuesta, consulta la colección `escalamientos` filtrando por
> `estado: "pendiente_agente"`.

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
  activos de un colegio (activo = tiene credenciales cargadas), con desglose por plataforma (Compartir/CREO).

Puedes armar un nodo HTTP Request + Schedule Trigger en n8n para traer cualquiera de los dos
periódicamente a una hoja de Google Sheets o a un dashboard, sin tocar el cerebro.

## Firma corporativa en las respuestas

**La firma NO se configura en n8n.** La añade el cerebro en `textoRespuestaHtml` (y en
`textoRespuesta` para la versión de texto plano), así que sale idéntica en todas las salidas:
respuestas del asistente, respuesta de un agente digital y correo de cierre por inactividad. Si se
pusiera en n8n habría que repetirla en cada nodo de envío y se desincronizaría a la primera.

Se edita en `apps/cerebro/src/utils/firma.js` (dirección, teléfonos, correo y webs).

### Logos — dos modos (`FIRMA_LOGOS`)

Los PNG viven en `apps/cerebro/src/assets/firma/` (ver su `LEEME.md`). Hay dos formas de mostrarlos,
según la variable `FIRMA_LOGOS` de la Lambda:

**Opción B — `FIRMA_LOGOS=url` (recomendada, la activa).** La propia Lambda sirve cada logo en
`{URL-CEREBRO}/?logo=santillana` (imagen estática, pública, caché de un año) y la firma los enlaza
con `<img src="…">`. **No hay que tocar n8n.** Requiere una variable más, `CEREBRO_URL`, con la
Function URL de la Lambda (la misma que usa n8n). Contra: Outlook de escritorio oculta las imágenes
externas hasta que el usuario pulsa "Descargar imágenes"; hasta entonces se ve el texto alternativo.
Es el compromiso aceptado: el 90 % del valor de la firma (dirección, teléfonos, webs) ya está en el
texto y no depende de las imágenes.

**Opción A — `FIRMA_LOGOS=cid`.** Los logos viajan adjuntos y se ven aunque el cliente bloquee
imágenes externas, pero el nodo *Microsoft Outlook* de n8n no expone `contentId`/`isInline`, así que
hay que sustituir el nodo `Outlook: Reply` por llamadas directas a Graph (createReply → PATCH →
attachments → send). Solo vale la pena si "Descargar imágenes" resulta molesto en la práctica.

**Vacío / sin definir.** Firma solo con texto, sin ninguna etiqueta `<img>`.

Para la opción B, en la Lambda `cerebro-sac`:
```
FIRMA_LOGOS = url
CEREBRO_URL = https://TU-FUNCTION-URL.lambda-url.us-east-2.on.aws
```
Compruébalo abriendo `{URL-CEREBRO}/?logo=santillana` en el navegador: debe descargar/mostrar el PNG.

## Dashboard de analítica

`https://{URL-CEREBRO}/?vista=dashboard` — no requiere despliegue aparte: lo sirve la misma Lambda.
Se refresca solo cada 30 s y trae selector de rango (7 / 30 / 90 días / todo).

Como la Function URL es pública, define `DASHBOARD_TOKEN` en la Lambda y entra con
`?vista=dashboard&token=EL-TOKEN`; la página lo propaga sola al pedir los datos. Sin la variable
definida, el dashboard queda abierto a cualquiera que conozca la URL.
