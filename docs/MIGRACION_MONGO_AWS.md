# Migración de MongoDB Atlas a AWS

Objetivo: que la base de datos deje de vivir en el cluster gratuito de Mongo Atlas y pase a la
cuenta AWS de la empresa (`668076963935`), donde ya viven las dos Lambdas.

> Nota previa: Atlas M0 ya corre *físicamente* sobre AWS, pero en la cuenta de MongoDB Inc., no en la
> nuestra. "Subir Mongo a AWS" significa que los datos queden en infraestructura de la cuenta
> corporativa, bajo sus políticas de acceso y respaldo.

Hay dos caminos. Para el piloto recomendamos la **Opción A** (EC2, gratis el primer año); para
producción real, la **Opción B** (DocumentDB, gestionado pero con costo).

| | Opción A: MongoDB en EC2 | Opción B: Amazon DocumentDB |
|---|---|---|
| Costo | $0 el primer año (t3.micro free tier), luego ~$8/mes | ~$60+/mes mínimo (t3.medium) |
| Mantenimiento | Tú administras (updates, backups) | AWS administra |
| Compatibilidad | MongoDB real, 100% | API compatible con MongoDB 5.0 (suficiente para este proyecto) |
| Red | IP pública con autenticación + TLS | Solo dentro de VPC (obliga a meter las Lambdas a la VPC + NAT Gateway ~$32/mes para que el cerebro siga saliendo a Gemini) |

---

## Opción A — MongoDB Community en EC2 (recomendada para el piloto)

### 1. Lanzar la instancia

Consola → **EC2 → Launch instance**:
- Name: `mongo-sac`
- AMI: **Ubuntu Server 24.04 LTS**
- Instance type: **t3.micro** (free tier 12 meses en cuentas nuevas; si la cuenta ya no aplica, es ~$8/mes)
- Key pair: crea una (`mongo-sac-key`) y guarda el `.pem`
- Network settings → **Edit**:
  - Security group nuevo: `sg-mongo-sac`
  - Regla 1: SSH (22) — Source: **My IP**
  - Regla 2: Custom TCP **27017** — Source: `0.0.0.0/0` ⚠️ (ver nota de seguridad abajo)
- Storage: 20 GiB gp3
- **Launch instance**

Luego **Elastic IPs → Allocate → Associate** con la instancia (para que la IP no cambie al reiniciar).

> ⚠️ **Por qué 27017 abierto a internet**: las Lambdas de este proyecto están *fuera* de VPC (para no
> pagar NAT Gateway) y sus IPs de salida cambian, así que no se puede restringir por IP. Mitigaciones
> obligatorias: autenticación con contraseña fuerte (paso 3), TLS (paso 4) y, además, las
> credenciales de estudiantes ya viajan **cifradas a nivel de campo** (AES-256-GCM) — aunque alguien
> lograra leer la base, no ve logins/contraseñas/PINs. Si prefieren cerrar 27017, la alternativa es
> mover las Lambdas a la VPC y pagar el NAT Gateway (~$32/mes).

### 2. Instalar MongoDB

```bash
ssh -i mongo-sac-key.pem ubuntu@IP_ELASTICA

# Repositorio oficial de MongoDB 7.0
sudo apt-get install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt-get update && sudo apt-get install -y mongodb-org
sudo systemctl enable --now mongod
```

### 3. Crear usuarios y activar autenticación

```bash
mongosh
```
```js
use admin
db.createUser({ user: "admin", pwd: "CONTRASEÑA_FUERTE_ADMIN", roles: ["root"] })
use sac
db.createUser({ user: "sac_app", pwd: "CONTRASEÑA_FUERTE_APP", roles: [{ role: "readWrite", db: "sac" }] })
exit
```

Edita `/etc/mongod.conf`:
```yaml
net:
  port: 27017
  bindIp: 0.0.0.0        # escucha conexiones externas (protegidas por auth + TLS + SG)
security:
  authorization: enabled
```
```bash
sudo systemctl restart mongod
```

### 4. TLS (recomendado)

Certificado autofirmado (suficiente para el piloto — el cliente se conecta con
`tlsAllowInvalidCertificates`):

```bash
sudo openssl req -newkey rsa:2048 -nodes -x509 -days 365 \
  -subj "/CN=mongo-sac" \
  -keyout /etc/ssl/mongo-sac.key -out /etc/ssl/mongo-sac.crt
sudo bash -c 'cat /etc/ssl/mongo-sac.key /etc/ssl/mongo-sac.crt > /etc/ssl/mongo-sac.pem'
sudo chown mongodb:mongodb /etc/ssl/mongo-sac.pem && sudo chmod 600 /etc/ssl/mongo-sac.pem
```

En `/etc/mongod.conf`, dentro de `net:`:
```yaml
  tls:
    mode: requireTLS
    certificateKeyFile: /etc/ssl/mongo-sac.pem
```
```bash
sudo systemctl restart mongod
```

### 5. Migrar los datos desde Atlas

Desde tu máquina (instala [MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools) si no los tienes):

```powershell
# 1. Exportar desde Atlas
mongodump --uri "mongodb+srv://usuario:password@cluster.mongodb.net/sac" --out .\dump-sac

# 2. Importar a EC2
mongorestore --uri "mongodb://sac_app:CONTRASEÑA_FUERTE_APP@IP_ELASTICA:27017/sac?tls=true&tlsAllowInvalidCertificates=true&authSource=sac" .\dump-sac\sac
```

> Si los datos de Atlas se cargaron ANTES de activar el cifrado de credenciales, lo más simple es
> **no migrar la colección `colegios`** y volver a subir los Excels con `apps/carga-credenciales`
> (que ya cifra al guardar). La colección `conversaciones` sí se migra tal cual.

### 6. Apuntar las Lambdas a la nueva base

El nuevo connection string es:

```
mongodb://sac_app:CONTRASEÑA_FUERTE_APP@IP_ELASTICA:27017/sac?tls=true&tlsAllowInvalidCertificates=true&authSource=sac
```

Actualiza `MONGODB_URI` en las **dos** Lambdas (`cerebro-sac` y `carga-credenciales-sac`):
Configuration → Environment variables → Edit (o el comando `aws lambda update-function-configuration`
de `docs/SETUP_AWS.md`, paso 6). Verifica con:

```powershell
Invoke-RestMethod -Uri "https://TU-URL-CARGA.lambda-url.us-east-2.on.aws/?listar=1"
```

### 7. Backups

Snapshot automático del volumen EBS: **EC2 → Elastic Block Store → Lifecycle Manager → Create
lifecycle policy** → snapshot diario, retener 7. (Los snapshots salen del free tier eventualmente,
pero con 20 GiB el costo es de centavos.)

Cuando todo esté verificado, pausa/elimina el cluster de Atlas para no dejar una copia huérfana de
los datos.

---

## Opción B — Amazon DocumentDB (producción)

1. **VPC**: usa la default. Crea un **DB subnet group** con 2+ subnets.
2. **DocumentDB → Create cluster**: 1 instancia `db.t3.medium`, engine 5.0, usuario `sac_app`.
3. **Security group**: permite 27017 solo desde el SG de las Lambdas.
4. **Lambdas dentro de la VPC**: Configuration → VPC → misma VPC/subnets + SG. ⚠️ El cerebro necesita
   salir a internet (API de Gemini): hay que crear un **NAT Gateway** (~$32/mes) en una subnet pública
   y rutearlo desde las subnets privadas de las Lambdas.
5. **TLS**: DocumentDB lo exige; descarga el bundle `global-bundle.pem` de AWS y agrégalo a la imagen
   Docker, con `?tls=true&tlsCAFile=/var/task/global-bundle.pem` en el URI.
6. Migración: mismo `mongodump`/`mongorestore` de la Opción A (desde una máquina con acceso a la VPC,
   ej. la propia EC2 bastion o Cloud9).

El código de las apps no cambia en ninguna de las dos opciones — solo `MONGODB_URI`.
