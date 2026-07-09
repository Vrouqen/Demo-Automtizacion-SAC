# Guía de despliegue en AWS (piloto, 100% capa gratuita)

Este proyecto tiene **dos Lambdas independientes** (imagen de contenedor Docker), cada una con su
propio repositorio ECR:

| App | Carpeta | Qué hace |
|---|---|---|
| `cerebro` | `apps/cerebro` | Recibe el correo parseado desde n8n, decide con Gemini y responde |
| `carga-credenciales` | `apps/carga-credenciales` | Recibe un Excel (JSON+base64) y lo guarda en Mongo Atlas |

**Todo lo de abajo cabe en la capa gratuita de AWS** (Lambda: 1M requests + 400,000 GB-seg/mes,
perpetuo, no solo primeros 12 meses; ECR: 500MB-mes gratis; SSM Parameter Store estándar: gratis).
Evitamos **Secrets Manager** (tiene costo, ~$0.40/secreto/mes) y **EC2** (su capa gratuita solo
aplica los primeros 12 meses de una cuenta nueva) a propósito por esto.

Requisitos previos: [AWS CLI](https://aws.amazon.com/cli/) instalado y configurado (`aws configure`)
con un usuario/rol que tenga permisos sobre ECR, Lambda, IAM y SSM. Docker instalado localmente.

---

## 1. Guardar las variables sensibles en SSM Parameter Store (gratis)

Repite por cada valor sensible (ajusta la región `--region` a la que uses, ej. `us-east-1`):

```bash
aws ssm put-parameter --name "/sac/MONGODB_URI" --type "SecureString" \
  --value "mongodb+srv://usuario:password@cluster.mongodb.net/?appName=MiApp" --region us-east-1

aws ssm put-parameter --name "/sac/GEMINI_API_KEY" --type "SecureString" \
  --value "TU_API_KEY_DE_GOOGLE_AI_STUDIO" --region us-east-1
```

`SecureString` en el tier estándar de Parameter Store es gratis (usa la llave KMS gestionada por AWS,
`aws/ssm`, sin costo adicional para este volumen). Más adelante, cuando Jira salga de standby, agrega
igual `/sac/JIRA_BASE_URL`, `/sac/JIRA_EMAIL`, `/sac/JIRA_API_TOKEN`.

---

## 2. Crear los repositorios ECR (uno por app)

```bash
aws ecr create-repository --repository-name cerebro-sac --region us-east-1
aws ecr create-repository --repository-name carga-credenciales-sac --region us-east-1
```

Guarda el `repositoryUri` que devuelve cada comando (algo como
`123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac`).

---

## 3. Build y push de las imágenes Docker

Autentica Docker contra ECR (una vez por sesión):

```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
```

**Cerebro:**

```bash
cd apps/cerebro
docker build -t cerebro-sac .
docker tag cerebro-sac:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac:latest
```

**Carga de credenciales:**

```bash
cd ../carga-credenciales
docker build -t carga-credenciales-sac .
docker tag carga-credenciales-sac:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/carga-credenciales-sac:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/carga-credenciales-sac:latest
```

---

## 4. Rol de ejecución de Lambda (IAM)

Crea un rol mínimo que permita ejecutar la función y leer los parámetros de SSM. Vía consola:
**IAM → Roles → Crear rol → Servicio: Lambda**, adjunta la política administrada
`AWSLambdaBasicExecutionRole` y esta política en línea para leer SSM:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:us-east-1:123456789012:parameter/sac/*"
    }
  ]
}
```

---

## 5. Crear las funciones Lambda (imagen de contenedor)

```bash
aws lambda create-function \
  --function-name cerebro-sac \
  --package-type Image \
  --code ImageUri=123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac:latest \
  --role arn:aws:iam::123456789012:role/rol-lambda-sac \
  --timeout 30 --memory-size 256 --region us-east-1

aws lambda create-function \
  --function-name carga-credenciales-sac \
  --package-type Image \
  --code ImageUri=123456789012.dkr.ecr.us-east-1.amazonaws.com/carga-credenciales-sac:latest \
  --role arn:aws:iam::123456789012:role/rol-lambda-sac \
  --timeout 30 --memory-size 512 --region us-east-1
```

`carga-credenciales-sac` tiene más memoria (512MB) porque procesa archivos Excel más pesados.

### Variables de entorno

Puedes pasarlas directo (más simple para el piloto) o resolverlas desde SSM en el propio código
(más "correcto" mismo pero más código). Para el piloto, lo más simple es referenciar el valor de SSM
al desplegar:

```bash
MONGODB_URI=$(aws ssm get-parameter --name "/sac/MONGODB_URI" --with-decryption --query Parameter.Value --output text --region us-east-1)
GEMINI_API_KEY=$(aws ssm get-parameter --name "/sac/GEMINI_API_KEY" --with-decryption --query Parameter.Value --output text --region us-east-1)

aws lambda update-function-configuration --function-name cerebro-sac --region us-east-1 \
  --environment "Variables={MONGODB_URI=$MONGODB_URI,MONGODB_DB=sac,GEMINI_API_KEY=$GEMINI_API_KEY,GEMINI_MODEL=gemini-1.5-flash,JIRA_HABILITADO=false}"

aws lambda update-function-configuration --function-name carga-credenciales-sac --region us-east-1 \
  --environment "Variables={MONGODB_URI=$MONGODB_URI,MONGODB_DB=sac,MONGODB_COLLECTION_COLEGIOS=colegios}"
```

> ⚠️ Esto deja el valor plano visible en la consola de Lambda (pestaña "Configuración" → "Variables de
> entorno") para quien tenga permisos de lectura sobre esa función — aceptable para un piloto interno,
> pero recuerda que la fuente de verdad sigue siendo SSM (rotar ahí y re-ejecutar el comando de arriba).

---

## 6. Exponer cada Lambda con una Function URL (gratis, sin API Gateway)

Una **Function URL** da una URL HTTPS pública directa a la Lambda, sin crear un recurso de API
Gateway aparte — más simple y sin costo adicional para este volumen.

```bash
aws lambda create-function-url-config \
  --function-name cerebro-sac --auth-type NONE --region us-east-1

aws lambda create-function-url-config \
  --function-name carga-credenciales-sac --auth-type NONE --region us-east-1
```

Cada comando devuelve un `FunctionUrl` (algo como
`https://abc123xyz.lambda-url.us-east-1.on.aws/`) — **guarda ambas URLs**, las necesitas para n8n
(ver `docs/SETUP_N8N.md`).

> `--auth-type NONE` deja el endpoint público sin autenticación — está bien para un piloto (nadie
> puede hacer nada sin conocer la URL exacta, que es larga y aleatoria), pero antes de producción
> real considera `--auth-type AWS_IAM` con las credenciales de n8n, o un secreto compartido validado
> dentro del propio handler (header personalizado).

También debes permitir invocaciones públicas sobre la función:

```bash
aws lambda add-permission \
  --function-name cerebro-sac --action lambda:InvokeFunctionUrl \
  --principal "*" --function-url-auth-type NONE --statement-id public-url --region us-east-1

aws lambda add-permission \
  --function-name carga-credenciales-sac --action lambda:InvokeFunctionUrl \
  --principal "*" --function-url-auth-type NONE --statement-id public-url --region us-east-1
```

---

## 7. Probar cada Lambda con curl

**Cerebro** (simula un correo ya parseado):

```bash
curl -X POST "https://TU-URL-CEREBRO.lambda-url.us-east-1.on.aws/" \
  -H "content-type: application/json" \
  -d '{
    "hiloId": "hilo-prueba-1",
    "remitente": "docente@colegio.edu.ec",
    "cuentaSoporte": "soporte1@empresa.com",
    "asunto": "Consulta de credenciales",
    "cuerpo": "Necesito las credenciales de Juan Pérez Narciso, colegio Unidad Educativa San Francisco de Quito, provincia Pichincha"
  }'
```

**Analítica** (reporte agregado):

```bash
curl "https://TU-URL-CEREBRO.lambda-url.us-east-1.on.aws/?reporte=analitica"
```

**Carga de credenciales** (convierte el Excel a base64 primero):

```bash
# Windows PowerShell:
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("credenciales.xlsx"))

curl -X POST "https://TU-URL-CARGA.lambda-url.us-east-1.on.aws/" \
  -H "content-type: application/json" \
  -d "{\"idColegio\":\"COL-001\",\"codigoColegio\":\"UE-QUITO-01\",\"nombreColegio\":\"Unidad Educativa San Francisco de Quito\",\"provincia\":\"Pichincha\",\"nombreArchivo\":\"credenciales.xlsx\",\"archivoBase64\":\"$b64\"}"
```

---

## 8. Actualizar el código más adelante

Cada vez que cambies algo en `apps/cerebro` o `apps/carga-credenciales`, repite el build+push+update:

```bash
docker build -t cerebro-sac .
docker tag cerebro-sac:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac:latest
aws lambda update-function-code --function-name cerebro-sac \
  --image-uri 123456789012.dkr.ecr.us-east-1.amazonaws.com/cerebro-sac:latest --region us-east-1
```

---

## Resumen de costos (piloto)

| Recurso | Costo | Nota |
|---|---|---|
| Lambda (ambas funciones) | $0 | Capa gratuita perpetua (1M req + 400,000 GB-seg/mes) |
| ECR | $0 | Primeros 500MB/mes gratis; dos imágenes Node pequeñas caben ahí |
| Function URL | $0 | No es un recurso de API Gateway, no tiene cargo aparte |
| SSM Parameter Store (estándar) | $0 | Tier estándar es gratis, sin límite de parámetros relevante aquí |
| MongoDB Atlas (M0) | $0 | Cluster gratuito, ya en uso |
| Google AI Studio (Gemini 1.5 Flash) | $0 | Con límites de tasa del tier gratuito |
| Outlook 365 (buzones compartidos) | $0 | Sin costo de licencia si son shared mailboxes |

Nada de esto tiene fecha de vencimiento distinta a "mientras dure el tier gratuito de cada servicio" —
si el piloto se aprueba y el volumen crece, este mismo diseño escala simplemente subiendo el `memory-size`
de Lambda o moviendo Mongo a un tier pagado, sin rehacer nada.
