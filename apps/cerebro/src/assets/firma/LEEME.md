# Logos de la firma de correo

Estos PNG se muestran en la firma de dos maneras posibles (variable `FIRMA_LOGOS`
de la Lambda):

- **`url` (opción B, la activa):** la propia Lambda los sirve en
  `{URL-CEREBRO}/?logo=<slug>` y la firma los enlaza con `<img>`. No toca n8n.
- **`cid` (opción A):** viajan adjuntos en el correo; se ven aunque el cliente
  bloquee imágenes externas, pero exige cambiar el nodo de respuesta de n8n.

El `slug` de cada logo es su nombre sin la extensión: `santillana`, `loqueleo`,
`compartir`, `richmond`, `creo`.

## Archivos actuales

| Archivo | Origen | Se muestra a | Escala | Peso |
|---|---|---|---|---|
| `santillana.png` | 163×47 | 150×43 | 1,09x | 8,7 KB |
| `loqueleo.png` | 92×50 | 88×48 | 1,05x | 1,6 KB |
| `compartir.png` | 145×40 | 118×33 | 1,23x | 2,8 KB |
| `richmond.png` | 135×40 | 93×28 | 1,45x | 2,8 KB |
| `creo.png` | 110×100 | 52×47 | 2,12x | 3,4 KB |

Todos en RGBA de 8 bits con canal alfa, **19,2 KB en total** — muy por debajo del
límite práctico de ~80 KB por correo. ✅

### Por qué los anchos no son todos iguales

Cada PNG trae una cantidad distinta de margen transparente (`loqueleo` es 54 %
lienzo vacío; `santillana`, 0 %), así que igualar anchos descuadra la tira. Los
valores de `LOGOS` en `src/utils/firma.js` están calculados para que los tres
wordmarks tengan la **misma altura de letra (~22 px)**. `creo` es un logo
apilado (icono + texto debajo), por eso va a ~2x esa altura.

### Pendiente de mejora (no bloquea)

- **Resolución.** Ninguno llega a 2x, así que en pantallas retina se verán algo
  suaves. Si consigues los originales vectoriales, reexporta a: santillana
  300 px, loqueleo 176 px, compartir 236 px, richmond 186 px, creo 104 px.
  `loqueleo` es el más justo (92 px de origen): es el que impide subir la altura
  de la tira, porque habría que ampliarlo.
- **`creo.png`.** Al ser apilado, su texto "sistemacreo.com" queda muy pequeño.
  Si existe una **versión horizontal** del logo, se leería mucho mejor.

## Cómo se activan

**Opción B (recomendada), en la Lambda `cerebro-sac`:**
```
FIRMA_LOGOS = url
CEREBRO_URL = https://TU-FUNCTION-URL.lambda-url.us-east-2.on.aws
```
Nada más. Compruébalo abriendo `{URL-CEREBRO}/?logo=santillana` en el navegador.

**Opción A (`cid`):** requiere además cambiar el nodo de respuesta de n8n por
llamadas directas a Graph — ver `docs/SETUP_N8N.md`.

Mientras `FIRMA_LOGOS` esté vacío, la firma sale **solo con texto** y no se emite
ninguna etiqueta `<img>`: es preferible una firma sobria a una con cuadros rotos.
