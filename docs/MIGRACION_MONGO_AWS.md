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

## Opción A — MongoDB en Docker sobre EC2 (recomendada para el piloto)

Mongo corre dentro de un contenedor Docker en la instancia (no instalado con `apt`). Los datos y el
certificado TLS viven en carpetas del host montadas como volúmenes, así que el contenedor se puede
tirar y volver a levantar (o subir de versión) sin perder nada — es la razón de elegir este camino:
versatilidad para actualizar/recrear sin reinstalar nada en el sistema operativo.

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
> obligatorias: autenticación con contraseña fuerte (paso 4), TLS (paso 3) y, además, las
> credenciales de estudiantes ya viajan **cifradas a nivel de campo** (AES-256-GCM) — aunque alguien
> lograra leer la base, no ve logins/contraseñas/PINs. Si prefieren cerrar 27017, la alternativa es
> mover las Lambdas a la VPC y pagar el NAT Gateway (~$32/mes).

### 2. Instalar Docker Engine

Conéctate a la instancia (SSH normal o el botón **Connect** de la consola EC2 — cualquiera de los dos
te da una terminal donde corren estos mismos comandos):

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo systemctl enable --now docker
```

Esto instala Docker Engine + el plugin `docker compose` (v2) en un solo paso. Verifica con
`sudo docker --version` y `sudo docker compose version`.

> Todos los comandos de aquí en adelante usan `sudo docker ...`. Si prefieres no escribir `sudo` cada
> vez: `sudo usermod -aG docker $USER` y vuelve a conectarte (cierra y abre la terminal) para que
> tome el nuevo grupo.

### 3. Carpetas persistentes y certificado TLS

```bash
sudo mkdir -p /data/mongo/db /data/mongo/certs /data/mongo/init
```

Certificado autofirmado (suficiente para el piloto — el cliente se conecta con
`tlsAllowInvalidCertificates`):

```bash
sudo openssl req -newkey rsa:2048 -nodes -x509 -days 365 \
  -subj "/CN=mongo-sac" \
  -keyout /data/mongo/certs/mongo-sac.key -out /data/mongo/certs/mongo-sac.crt
sudo bash -c 'cat /data/mongo/certs/mongo-sac.key /data/mongo/certs/mongo-sac.crt > /data/mongo/certs/mongo-sac.pem'
sudo chmod 600 /data/mongo/certs/mongo-sac.pem
```

Script que crea el usuario de la app (la imagen oficial de Mongo lo ejecuta automáticamente la
**primera vez** que arranca con `/data/mongo/db` vacío):

```bash
sudo tee /data/mongo/init/init-sac.js > /dev/null <<'EOF'
db = db.getSiblingDB('sac');
db.createUser({ user: 'sac_app', pwd: 'CONTRASEÑA_FUERTE_APP', roles: [{ role: 'readWrite', db: 'sac' }] });
EOF
```

### 4. Primer arranque (crea los usuarios, todavía sin TLS/auth)

Arranque "de una sola vez" (no queda corriendo) que dispara el bootstrap de usuarios de la imagen
oficial — crea el usuario `admin` (root) vía variables de entorno y, gracias al script del paso
anterior, también `sac_app`:

```bash
sudo docker run --rm \
  -v /data/mongo/db:/data/db \
  -v /data/mongo/init:/docker-entrypoint-initdb.d \
  -e MONGO_INITDB_ROOT_USERNAME=admin \
  -e MONGO_INITDB_ROOT_PASSWORD=CONTRASEÑA_FUERTE_ADMIN \
  mongo:7.0 --auth
```

Espera a ver una línea de log tipo `Waiting for connections` y luego detén el contenedor con
`Ctrl+C` (el `--rm` ya lo limpia solo). Los usuarios quedan creados en `/data/mongo/db`.

> Si te equivocas en las contraseñas aquí, la corrección es simple: `sudo rm -rf /data/mongo/db/*` y
> repite este paso — no hay nada más que limpiar.

### 5. Arranque definitivo (Docker Compose, con auth + TLS)

```bash
sudo mkdir -p /opt/mongo-sac
sudo tee /opt/mongo-sac/docker-compose.yml > /dev/null <<'EOF'
services:
  mongo:
    image: mongo:7.0
    container_name: mongo-sac
    restart: unless-stopped
    ports:
      - "27017:27017"
    command: ["--auth", "--tlsMode", "requireTLS", "--tlsCertificateKeyFile", "/etc/ssl/mongo-sac.pem"]
    volumes:
      - /data/mongo/db:/data/db
      - /data/mongo/certs:/etc/ssl
EOF

cd /opt/mongo-sac
sudo docker compose up -d
sudo docker compose logs -f mongo   # Ctrl+C para salir del log una vez veas "Waiting for connections"
```

Verifica la conexión (desde la propia instancia):

```bash
sudo docker exec -it mongo-sac mongosh \
  "mongodb://sac_app:CONTRASEÑA_FUERTE_APP@localhost:27017/sac?tls=true&tlsAllowInvalidCertificates=true&authSource=sac" \
  --eval "db.runCommand({ ping: 1 })"
```

**Actualizar la versión de Mongo más adelante** (la ventaja de este montaje): cambia `mongo:7.0` por
el tag que quieras en `docker-compose.yml` y corre `sudo docker compose pull && sudo docker compose up -d`
— los datos en `/data/mongo/db` no se tocan.

### 6. Migrar los datos desde Atlas

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

### 7. Apuntar las Lambdas a la nueva base

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

### 8. Backups

Snapshot automático del volumen EBS: **EC2 → Elastic Block Store → Lifecycle Manager → Create
lifecycle policy** → snapshot diario, retener 7. (Los snapshots salen del free tier eventualmente,
pero con 20 GiB el costo es de centavos.) Como `/data/mongo` vive en el volumen raíz de la instancia,
el snapshot del volumen cubre datos + certificado + `docker-compose.yml` sin configuración aparte.

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
