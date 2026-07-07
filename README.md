# Demo-Automtizaci-n-SAC

API en FastAPI para cargar un Excel con credenciales y guardarlas como diccionario en MongoDB Atlas.

## Requisitos

- Python 3.10+
- Variables de entorno:
  - `MONGODB_URI` (obligatoria)
  - `MONGODB_DB` (opcional, default: `sac`)
  - `MONGODB_COLLECTION` (opcional, default: `credentials`)

## Instalación

```bash
pip install -r requirements.txt
```

## Ejecución

```bash
uvicorn main:app --reload
```

## Endpoint

- `POST /credentials/{credential_id}`
- `multipart/form-data` con campo `file` (archivo `.xlsx`)

Ejemplo:

```bash
curl -X POST "http://127.0.0.1:8000/credentials/mi-id" \
  -F "file=@credenciales.xlsx"
```
