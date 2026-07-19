# Guía de despliegue en AWS (piloto, 100% capa gratuita)

Cuenta AWS a usar: **`668076963935`**. Región recomendada: **`us-east-2`** (si la empresa ya
estandariza otra región para sus proyectos, usa esa en su lugar — solo reemplázala en todos los
comandos/pantallas de abajo).

Este proyecto tiene **dos Lambdas independientes** (imagen de contenedor Docker):

| App | Carpeta | Qué hace |
|---|---|---|
| `cerebro` | `apps/cerebro` | Recibe el correo parseado desde n8n, decide con Gemini y responde |
| `carga-credenciales` | `apps/carga-credenciales` | Recibe un Excel (JSON+base64) y lo guarda en Mongo Atlas |

**Todo lo de abajo cabe en la capa gratuita de AWS** (Lambda: 1M requests + 400,000 GB-seg/mes,
perpetuo, no solo primeros 12 meses; ECR: 500MB-mes gratis). Evitamos **EC2** (su capa gratuita solo
aplica los primeros 12 meses de una cuenta nueva) a propósito.

Cada paso trae dos caminos — sigue el que te resulte más cómodo, no hace falta hacer ambos:
- **🖱️ Consola (recomendado si no manejas mucho AWS)** — todo por clics en el navegador.
- **⌨️ CLI** — los mismos comandos de `aws`, escritos para **Windows PowerShell** (no bash — si pegas
  esto en Git Bash o WSL, cambia `$variable = comando` por `variable=$(comando)`).

> Hay **un solo paso que obligatoriamente es por terminal**: construir y subir la imagen Docker (no
> existe forma de hacer `docker build`/`docker push` desde el navegador). Todo lo demás sí tiene
> alternativa 100% gráfica.

### Requisitos previos

1. Acceso a la consola de AWS con la cuenta `668076963935` (que te den un usuario/rol con permisos
   sobre Lambda, ECR, IAM y Systems Manager).
2. [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado en tu máquina (para
   el paso de build/push de la imagen).
3. Si vas a usar la CLI en algún paso: [AWS CLI](https://aws.amazon.com/cli/) instalado y configurado
   con `aws configure` (te pedirá un Access Key / Secret Key — pídelos a quien administre la cuenta,
   o genera los tuyos en **IAM → Users → tu usuario → Security credentials → Create access key**).

---

## 0. Permitir que las Lambdas lleguen a MongoDB Atlas (Network Access)

⚠️ **Paso obligatorio, se olvida fácil y produce un 502 en la Function URL si se salta.**

Las Lambdas de este proyecto corren **fuera de una VPC** (a propósito, para no pagar NAT Gateway —
ver el costo en `docs/MIGRACION_MONGO_AWS.md`). Eso significa que sus conexiones salientes usan IPs
públicas dinámicas del pool compartido de AWS: **no existe una IP fija ni una lista corta que
whitelistear** en Atlas.

En **MongoDB Atlas → tu proyecto → Network Access → Add IP Address → Allow Access from Anywhere
(`0.0.0.0/0`)**. La seguridad la sigue dando el usuario/contraseña del connection string y, dentro de
Mongo, el cifrado de campo de login/contraseña (mismo razonamiento que el puerto 27017 abierto en
la opción EC2 de `MIGRACION_MONGO_AWS.md`).

Si dejas Atlas con una IP específica whitelisteada (ej. la tuya de casa), las Lambdas se conectarán
desde una IP distinta, Atlas rechazará la conexión, `MongoClient.connect()` colgará hasta agotar
`serverSelectionTimeoutMS` y la Function URL devolverá **502 Bad Gateway**. Si te pasa esto, confírmalo
en **CloudWatch Logs** de la función (busca `MongoServerSelectionError` o `connection timed out`).

---

## 1. Guardar el connection string de Mongo y la key de Gemini (Parameter Store)

Guardamos los dos valores sensibles en **SSM Parameter Store** (gratis, tier estándar) para no
tenerlos sueltos en ningún archivo. Es opcional para el piloto — más abajo, en el paso 6, también
puedes pegarlos directo como variables de entorno de Lambda si prefieres el camino más corto. Si
optas por lo directo, **puedes saltarte este paso 1**.

### 🖱️ Consola

1. Busca **"Systems Manager"** en la barra de búsqueda de arriba → entra al servicio.
2. En el menú de la izquierda: **Parameter Store** (bajo "Application Management").
3. **Create parameter**:
   - Name: `/sac/MONGODB_URI`
   - Tier: `Standard`
   - Type: `SecureString` (deja la KMS key por defecto, `alias/aws/ssm` — no tiene costo extra)
   - Value: pega tu connection string de Mongo Atlas
   - **Create parameter**
4. Repite con `Name: /sac/GEMINI_API_KEY` y el valor de tu API key de Google AI Studio.

### ⌨️ CLI

```powershell
aws ssm put-parameter --name "/sac/MONGODB_URI" --type "SecureString" --value "mongodb+srv://usuario:password@cluster.mongodb.net/?appName=MiApp" --region us-east-2

aws ssm put-parameter --name "/sac/GEMINI_API_KEY" --type "SecureString" --value "TU_API_KEY_DE_GOOGLE_AI_STUDIO" --region us-east-2
```

---

## 2. Crear los repositorios ECR (uno por app)

ECR es donde vive la imagen Docker antes de que Lambda la use.

### 🖱️ Consola

1. Busca **"ECR"** o **"Elastic Container Registry"** → entra al servicio.
2. **Repositories** → **Create repository**.
   - Visibility settings: `Private`
   - Repository name: `cerebro-sac`
   - Deja el resto por defecto → **Create repository**
3. Repite con `carga-credenciales-sac`.
4. **Truco útil**: entra al repositorio recién creado y pulsa el botón **"View push commands"**
   (arriba a la derecha) — AWS te muestra los 4 comandos exactos (`login`, `build`, `tag`, `push`) ya
   con tu cuenta y región puestas, listos para copiar y pegar en la terminal (paso 3).

### ⌨️ CLI

```powershell
aws ecr create-repository --repository-name cerebro-sac --region us-east-2
aws ecr create-repository --repository-name carga-credenciales-sac --region us-east-2
```

---

## 3. Build y push de las imágenes Docker (⌨️ obligatoriamente en terminal)

Abre una terminal en la carpeta del proyecto. Autentica Docker contra ECR (una vez por sesión de
terminal — o copia el comando exacto del botón "View push commands" del paso 2):

```powershell
$loginPassword = aws ecr get-login-password --region us-east-2
$loginPassword | docker login --username AWS --password-stdin 668076963935.dkr.ecr.us-east-2.amazonaws.com
```

Debe responder `Login Succeeded`.

**Cerebro:**

```powershell
cd apps/cerebro

docker build `
  --platform linux/amd64 `
  --provenance=false `
  -t cerebro-sac .

docker tag cerebro-sac:latest 668076963935.dkr.ecr.us-east-2.amazonaws.com/cerebro-sac:latest

docker push 668076963935.dkr.ecr.us-east-2.amazonaws.com/cerebro-sac:latest
```

**Carga de credenciales:**

```powershell
cd ../carga-credenciales

docker build `
  --platform linux/amd64 `
  --provenance=false `
  -t carga-credenciales-sac .

docker tag carga-credenciales-sac:latest 668076963935.dkr.ecr.us-east-2.amazonaws.com/carga-credenciales-sac:latest

docker push 668076963935.dkr.ecr.us-east-2.amazonaws.com/carga-credenciales-sac:latest
```

Verifica en la consola: entra al repo en ECR → pestaña **Images** → debe aparecer una imagen con tag
`latest`.

---

## 4. Rol de ejecución de Lambda (IAM)

Un rol mínimo que permita a Lambda ejecutarse y (si usaste el paso 1) leer los parámetros de SSM.

### 🖱️ Consola

1. Busca **"IAM"** → **Roles** → **Create role**.
2. Trusted entity type: `AWS service`. Use case: `Lambda` → **Next**.
3. En "Add permissions", busca y marca la política **`AWSLambdaBasicExecutionRole`** → **Next**.
4. Role name: `rol-lambda-sac` → **Create role**.
5. **Solo si usaste el paso 1 (SSM):** entra al rol recién creado → pestaña **Permissions** →
   **Add permissions → Create inline policy** → pestaña **JSON** → pega:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["ssm:GetParameter", "ssm:GetParameters"],
         "Resource": "arn:aws:ssm:us-east-2:668076963935:parameter/sac/*"
       }
     ]
   }
   ```
   → **Next** → nómbrala `leer-ssm-sac` → **Create policy**.
6. Copia el **ARN del rol** (arriba de la página del rol, algo como
   `arn:aws:iam::668076963935:role/rol-lambda-sac`) — lo necesitas en el paso 5.

### ⌨️ CLI

```powershell
$trustPolicy = @'
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole" }]
}
'@
aws iam create-role --role-name rol-lambda-sac --assume-role-policy-document $trustPolicy

aws iam attach-role-policy --role-name rol-lambda-sac --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

$ssmPolicy = @'
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:GetParameters"], "Resource": "arn:aws:ssm:us-east-2:668076963935:parameter/sac/*" }]
}
'@
aws iam put-role-policy --role-name rol-lambda-sac --policy-name leer-ssm-sac --policy-document $ssmPolicy
```

> El bloque `$variable = @' ... '@` es un "here-string" de PowerShell — pégalo tal cual, incluyendo
> las líneas `@'` y `'@` (esta última debe quedar sola, sin espacios antes).

---

## 5. Crear las funciones Lambda (imagen de contenedor)

### 🖱️ Consola

1. Busca **"Lambda"** → **Functions** → **Create function**.
2. Selecciona **"Container image"** (no "Author from scratch").
3. Function name: `cerebro-sac`.
4. Container image URI: **Browse images** → selecciona el repositorio `cerebro-sac` → tag `latest`.
5. Architecture: **`x86_64`** — ⚠️ NO selecciones `arm64`/Graviton aunque la consola lo sugiera como
   más barato: el `Dockerfile` construye con `--platform linux/amd64` (paso 3), y si la arquitectura
   de la función no coincide con la de la imagen, la función falla en cada invocación con
   `Runtime.InvalidEntrypoint` (falla en milisegundos, antes de ejecutar una sola línea de tu código).
6. Despliega **"Change default execution role"** → `Use an existing role` → selecciona
   `rol-lambda-sac`.
7. **Create function**.
8. Repite todo con `carga-credenciales-sac` apuntando al repo `carga-credenciales-sac`.
9. En cada función: pestaña **Configuration → General configuration → Edit**:
   - `cerebro-sac`: Timeout `30 sec`, Memory `256 MB`.
   - `carga-credenciales-sac`: Timeout `30 sec`, Memory `512 MB` (procesa Excel más pesados).
   - **Save**.

### ⌨️ CLI

```powershell
aws lambda create-function --function-name cerebro-sac --package-type Image --code ImageUri=668076963935.dkr.ecr.us-east-2.amazonaws.com/cerebro-sac:latest --role arn:aws:iam::668076963935:role/rol-lambda-sac --timeout 30 --memory-size 256 --region us-east-2

aws lambda create-function --function-name carga-credenciales-sac --package-type Image --code ImageUri=668076963935.dkr.ecr.us-east-2.amazonaws.com/carga-credenciales-sac:latest --role arn:aws:iam::668076963935:role/rol-lambda-sac --timeout 30 --memory-size 512 --region us-east-2
```

---

## 6. Variables de entorno

**Camino simple (recomendado para el piloto):** pega los valores directo en cada función.

Antes de configurar, **genera la clave de cifrado de credenciales** (32 bytes en base64 — cifra
login/contraseña dentro de Mongo; debe ser LA MISMA en ambas Lambdas):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Guárdala en un lugar seguro (ej. SSM Parameter Store como `/sac/CREDENCIALES_ENC_KEY`, igual que en
el paso 1). Si se pierde la clave, no se pueden descifrar las credenciales ya cargadas (habría que
volver a subir los Excels).

### 🖱️ Consola

1. Entra a la función `cerebro-sac` → pestaña **Configuration → Environment variables → Edit**.
2. **Add environment variable** por cada una:
   - `MONGODB_URI` = tu connection string de Mongo (Atlas o, tras la migración, la instancia en AWS —
     ver `docs/MIGRACION_MONGO_AWS.md`)
   - `MONGODB_DB` = `sac`
   - `GEMINI_API_KEY` = tu API key de Google AI Studio
   - `GEMINI_MODEL` = `gemini-2.5-flash`
   - `GEMINI_MODEL_FALLBACK` = `gemini-3.5-flash` (opcional; ese es el valor por defecto) — si el
     modelo principal agota su cuota diaria (429), el cerebro reintenta la misma llamada con este
     modelo. En el tier gratuito cada modelo tiene cuota propia, así que esto duplica el presupuesto
     diario efectivo. Pon el valor vacío para desactivar el respaldo.
   - `CREDENCIALES_ENC_KEY` = la clave generada arriba
   - `AGENTES_DIGITALES` = correos de los agentes digitales de servicio, separados por coma
     (ej. `digital1@empresa.com,digital2@empresa.com`) — los casos escalados se reparten en
     round-robin entre ellos
   - `JIRA_HABILITADO` = `false`
3. **Save**.
4. En `carga-credenciales-sac` → mismo camino, necesita `MONGODB_URI`, `MONGODB_DB`,
   `MONGODB_COLLECTION_COLEGIOS` = `colegios`, `CREDENCIALES_ENC_KEY` (la MISMA clave que en
   `cerebro-sac`) y, para el formulario web:
   - `APP_USUARIO` = `sac_app`
   - `APP_CLAVE` = la contraseña de acceso al formulario (ej. `SacApp2026!`)

> ⚠️ `APP_CLAVE` es **obligatoria**: si falta, la función responde error en vez de servir el
> formulario. Es a propósito — la Function URL es pública (`Auth type: NONE`), así que sin esa clave
> el endpoint quedaría abierto a internet. El login se valida en el servidor y entrega un token
> firmado (HMAC, válido 8 horas) que exigen `POST /` y `GET ?listar=1`.

> Esto deja el valor plano visible en esa pantalla para quien tenga permiso de leer la función —
> aceptable para un piloto interno. Si prefieres no exponerlo ahí, usa el camino con SSM de abajo.

### ⌨️ CLI (con valores directos)

```powershell
aws lambda update-function-configuration --function-name cerebro-sac --region us-east-2 --environment "Variables={MONGODB_URI=TU_URI,MONGODB_DB=sac,GEMINI_API_KEY=TU_KEY,GEMINI_MODEL=gemini-2.5-flash,CREDENCIALES_ENC_KEY=TU_CLAVE_BASE64,AGENTES_DIGITALES='digital1@empresa.com,digital2@empresa.com',JIRA_HABILITADO=false}"

aws lambda update-function-configuration --function-name carga-credenciales-sac --region us-east-2 --environment "Variables={MONGODB_URI=TU_URI,MONGODB_DB=sac,MONGODB_COLLECTION_COLEGIOS=colegios,CREDENCIALES_ENC_KEY=TU_CLAVE_BASE64}"
```

### ⌨️ CLI (leyendo desde SSM, si hiciste el paso 1)

```powershell
$MONGODB_URI = aws ssm get-parameter --name "/sac/MONGODB_URI" --with-decryption --query Parameter.Value --output text --region us-east-2
$GEMINI_API_KEY = aws ssm get-parameter --name "/sac/GEMINI_API_KEY" --with-decryption --query Parameter.Value --output text --region us-east-2

aws lambda update-function-configuration --function-name cerebro-sac --region us-east-2 --environment "Variables={MONGODB_URI=$MONGODB_URI,MONGODB_DB=sac,GEMINI_API_KEY=$GEMINI_API_KEY,GEMINI_MODEL=gemini-2.5-flash,JIRA_HABILITADO=false}"
```

---

## 7. Exponer cada Lambda con una Function URL (gratis, sin API Gateway)

Una **Function URL** da una URL HTTPS pública directa a la Lambda — más simple que crear un API
Gateway aparte, y sin costo adicional para este volumen.

### 🖱️ Consola

1. Entra a `cerebro-sac` → pestaña **Configuration → Function URL → Create function URL**.
2. Auth type: `NONE`.
3. Te va a preguntar "This will make your function URL publicly accessible" — confirma (aceptable
   para el piloto; ver nota de seguridad al final).
4. **Save** → copia la **Function URL** que aparece (algo como
   `https://abc123xyz.lambda-url.us-east-2.on.aws/`).
5. Repite con `carga-credenciales-sac`.

Con la consola, el paso de "permitir invocación pública" (`add-permission` en CLI) se hace solo — no
necesitas nada adicional.

### ⌨️ CLI

```powershell
aws lambda create-function-url-config --function-name cerebro-sac --auth-type NONE --region us-east-2
aws lambda add-permission --function-name cerebro-sac --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE --statement-id public-url --region us-east-2

aws lambda create-function-url-config --function-name carga-credenciales-sac --auth-type NONE --region us-east-2
aws lambda add-permission --function-name carga-credenciales-sac --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE --statement-id public-url --region us-east-2
```

**Guarda ambas Function URLs** — las necesitas para configurar n8n (ver `docs/SETUP_N8N.md`).

> `Auth type: NONE` deja el endpoint público sin autenticación — está bien para un piloto (la URL es
> larga y aleatoria, nadie la adivina), pero antes de producción real considera `AWS_IAM` o un
> secreto compartido validado dentro del propio handler.

---

## 8. Probar cada Lambda

Puedes usar `Invoke-RestMethod` (nativo de PowerShell), `curl.exe` en terminal, o un cliente gráfico
como **Postman**/**Insomnia** si prefieres no usar la terminal (pega la misma URL, método `POST`,
header `Content-Type: application/json`, y el body de ejemplo de abajo).

> ⚠️ En Windows PowerShell, `curl` (sin `.exe`) es un alias de `Invoke-WebRequest` y **no** acepta los
> flags `-X`/`-H`/`-d` de curl real — usa siempre `curl.exe` explícito (así se llama al binario real
> de curl, no al alias), o usa `Invoke-RestMethod` como en los ejemplos de abajo.

**Cerebro** (simula un correo ya parseado) — con `Invoke-RestMethod`:

```powershell
$body = @{
  hiloId = "hilo-prueba-1"
  remitente = "docente@colegio.edu.ec"
  cuentaSoporte = "soporte1@empresa.com"
  asunto = "Consulta de credenciales"
  cuerpo = "Necesito las credenciales de Juan Pérez Narciso, colegio Unidad Educativa San Francisco de Quito, provincia Pichincha"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://TU-URL-CEREBRO.lambda-url.us-east-2.on.aws/" -ContentType "application/json" -Body $body
```

O con `curl.exe`:

```powershell
curl.exe -X POST "https://TU-URL-CEREBRO.lambda-url.us-east-2.on.aws/" -H "content-type: application/json" -d '{"hiloId":"hilo-prueba-1","remitente":"docente@colegio.edu.ec","cuentaSoporte":"soporte1@empresa.com","asunto":"Consulta de credenciales","cuerpo":"Necesito las credenciales de Juan Perez Narciso, colegio Unidad Educativa San Francisco de Quito, provincia Pichincha"}'
```

**Analítica** (reporte agregado):

```powershell
Invoke-RestMethod -Method Get -Uri "https://TU-URL-CEREBRO.lambda-url.us-east-2.on.aws/?reporte=analitica"
```

**Estudiantes activos de un colegio** (activo = tiene credenciales cargadas; `idColegio` es el id de Pegasus):

```powershell
Invoke-RestMethod -Method Get -Uri "https://TU-URL-CEREBRO.lambda-url.us-east-2.on.aws/?reporte=estudiantes_activos&idColegio=COL-001"
```

**Carga de credenciales — formulario web (lo normal)**: abre la Function URL de
`carga-credenciales-sac` directo en el navegador (sin nada después de la `/`). Pide usuario y
contraseña (`APP_USUARIO` / `APP_CLAVE` del paso 6) y luego permite subir el Excel sin terminal ni
Postman: busca el colegio por nombre (tolera errores de tipeo), autocompleta sus datos si ya está
registrado, y encadena región → provincia → cantón.

**Carga de credenciales — vía API** (para automatizar). Primero autentícate y guarda el token; toda
petición de datos lo necesita:

```powershell
$login = Invoke-RestMethod -Method Post -Uri "https://TU-URL-CARGA.lambda-url.us-east-2.on.aws/?login=1" -ContentType "application/json" -Body (@{ usuario = "sac_app"; clave = "TU_APP_CLAVE" } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.token)" }

$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("credenciales.xlsx"))

$body = @{
  idColegio = "COL-001"                 # id del colegio en Pegasus
  codigoColegio = "UE-QUITO-01"
  region = "Sierra"                     # solo "Costa" o "Sierra"
  ciudad = "Pichincha"                  # Ciudad (Provincia)
  canton = "Quito"
  nombreColegio = "Unidad Educativa San Francisco de Quito"   # nombre del avance
  plataforma = "compartir"              # o "creo"
  periodo = "2026-2027"                 # periodo escolar (formato AAAA-AAAA)
  nombreArchivo = "credenciales.xlsx"
  archivoBase64 = $b64
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://TU-URL-CARGA.lambda-url.us-east-2.on.aws/" -ContentType "application/json" -Headers $headers -Body $body

# Listado de colegios cargados (también requiere el token)
Invoke-RestMethod -Uri "https://TU-URL-CARGA.lambda-url.us-east-2.on.aws/?listar=1" -Headers $headers
```

> La carga es **progresiva por plataforma y periodo**: subir `compartir 2026-2027` solo toca esos
> registros y deja intactos los de `creo` o los de otros periodos del mismo colegio.
>
> Dentro de esa plataforma+periodo la carga **fusiona por persona** (identificada por su login, o por
> su nombre completo si la fila no trae login): a quien ya existía se le actualizan sus credenciales
> y a quien no, se le agrega. **No se borra a nadie que no venga en el archivo**, así que una carga
> parcial (por ejemplo, solo los alumnos a los que les cambió la contraseña) es segura. La respuesta
> lo detalla en `estudiantes`: `nuevos`, `actualizados` (ya existían y su contraseña cambió),
> `sinCambios`, `totalPeriodo` y `totalColegio`, más `hojasIgnoradas` (las pestañas que quedaron
> fuera, típicamente "Docentes").

Si algo falla, revisa los logs: en la consola, entra a la función → pestaña **Monitor → View
CloudWatch logs** → el log más reciente muestra el error exacto.

---

## 9. Actualizar el código más adelante

Cada vez que cambies algo en `apps/cerebro` o `apps/carga-credenciales`, repite el build+push (paso 3)
y luego:

### 🖱️ Consola

Entra a la función → botón **Deploy new image** (o en algunas versiones de la consola, dentro de
**Image → Deploy new image**) → confirma que apunta al tag `latest` → **Save**. Este camino no toca
la arquitectura de la función, así que no hay riesgo de desalineamiento.

### ⌨️ CLI

```powershell
aws lambda update-function-code --function-name cerebro-sac --image-uri 668076963935.dkr.ecr.us-east-2.amazonaws.com/cerebro-sac:latest --region us-east-2
```

---

## Resumen de costos (piloto)

| Recurso | Costo | Nota |
|---|---|---|
| Lambda (ambas funciones) | $0 | Capa gratuita perpetua (1M req + 400,000 GB-seg/mes) |
| ECR | $0 | Primeros 500MB/mes gratis; dos imágenes Node pequeñas caben ahí |
| Function URL | $0 | No es un recurso de API Gateway, no tiene cargo aparte |
| SSM Parameter Store (estándar) | $0 | Tier estándar es gratis (si lo usas) |
| MongoDB Atlas (M0) | $0 | Cluster gratuito, ya en uso — migración a AWS: ver `docs/MIGRACION_MONGO_AWS.md` |
| Google AI Studio (Gemini) | $0 | Con límites de tasa del tier gratuito |
| Outlook 365 (buzones compartidos) | $0 | Sin costo de licencia si son shared mailboxes |

Nada de esto tiene fecha de vencimiento distinta a "mientras dure el tier gratuito de cada servicio" —
si el piloto se aprueba y el volumen crece, este mismo diseño escala simplemente subiendo el `memory-size`
de Lambda o moviendo Mongo a un tier pagado, sin rehacer nada.
