# Debug Session: damaged-statuses-8am
- **Status**: [OPEN]
- **Issue**: El workflow `ALUMAS - Estados diarios 8AM Evolution` sigue publicando estados con imágenes dañadas.
- **Debug Server**: Pending start
- **Log File**: .dbg/trae-debug-log-damaged-statuses-8am.ndjson

## Reproduction Steps
1. Inspeccionar el workflow activo en n8n.
2. Ejecutar una corrida controlada del generador y del flujo de publicación.
3. Confirmar si el archivo generado, la URL utilizada y el resultado del envío coinciden.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | El workflow activo sigue publicando con una ruta distinta a la esperada. | High | Low | Rejected: el workflow activo usa `internal_url` y `delivery_file_name`. |
| B | La URL elegida no es accesible desde el consumidor real del archivo. | High | Medium | Rejected: `evolution_api` descarga correctamente `status_generator:8000/generated/.../status_01.jpg`. |
| C | Evolution recibe el archivo pero lo procesa mal por formato o tipo de envío. | Medium | Medium | Confirmed: `sendStatus` acepta la imagen y devuelve `imageMessage`, pero el mensaje termina en `status 0` con `messageStubParameters ["400"]`. |
| D | El workflow publica el archivo original incorrecto en vez del JPG de entrega. | High | Low | Rejected: fallan también una imagen JPEG de control simple y una imagen JPEG pública externa. |
| E | Un nodo intermedio del trabajo de las 8 AM altera los datos antes de publicar. | Medium | Medium | Confirmed parcialmente: el problema operativo real está en el nodo HTTP, que agota el timeout de n8n. |

## Log Evidence
- `workflowId=3Fj5HTz7S7ux1ekd` falla de forma recurrente en las ejecuciones `8`, `12`, `17`, `21` y `25`.
- Ejecución `25`:
  - nodo fallido: `Publicar estado en Evolution`
  - `itemIndex: 1`
  - `content: http://status_generator:8000/generated/20260826/130001_da1a6ec3/status_02.jpg`
  - error: `timeout of 300000ms exceeded` / `ECONNABORTED`
- Verificación desde `evolution_api`:
  - descarga correcta de `status_01.jpg` por `internal_url` y por URL pública
  - firma JPEG válida en el archivo descargado
- Prueba manual directa contra Evolution:
  - dos envíos secuenciales de `status_01.jpg` y `status_02.jpg`
  - ambos respondieron `HTTP 201`
  - tiempos observados: `178.45s` y `179.53s`
  - respuesta con `imageMessage`, `mimetype: image/jpeg`, `width: 1080`, `height: 1920`
- Prueba controlada con imagen mínima generada para depuración:
  - archivo: `control_simple.jpg`
  - `fileLength: 74577`
  - respuesta `PENDING` con `imageMessage`
  - resultado final en logs: `status 0`, `messageStubParameters ["400"]`
- Prueba controlada con imagen externa pública:
  - fuente: `https://picsum.photos/1080/1920.jpg`
  - respuesta `PENDING` con `imageMessage`
  - resultado final en logs: `status 0`, `messageStubParameters ["400"]`
- Nuevo síntoma reportado por usuario:
  - WhatsApp Web muestra el estado y la imagen
  - en el teléfono del emisor el estado aparece dañado
  - un contacto no ve el estado como si no se hubiera publicado
- Evidencia adicional de fanout:
  - prueba `status@broadcast` con `baileys 7.0.0-rc14` sigue terminando en:
    - `status 0`
    - `messageStubParameters ["400"]`
  - respuesta previa del API sigue mostrando `imageMessage` completo con `url`, `directPath`, hashes y `messageContextInfo.messageSecret`
  - pruebas por lotes pequeños de destinatarios (`statusJidList` limitado) no muestran el mismo rechazo inmediato observado en `allContacts`

## Verification Conclusion
- El archivo no nace dañado en el generador.
- Evolution sí puede descargar y publicar el JPG válido.
- La causa inmediata del fallo del workflow es doble:
  - el timeout de 5 minutos del nodo HTTP en n8n era insuficiente para un lote donde cada estado tarda ~3 minutos
  - aun corrigiendo ese timeout, `sendStatus` de Evolution/Baileys sigue terminando en `status 0 / 400` incluso con imágenes de control externas y simples
- Fix mínimo aplicado en template: `options.timeout = 3600000` para `Publicar estado en Evolution`.
- El problema ya no apunta a la creación de las imágenes de ALUMAS.
- El problema actual apunta al fanout/publicación real del `status@broadcast` entre Web, móvil y destinatarios.
- La actualización de `baileys` desde `7.0.0-rc.9` a `7.0.0-rc14` no eliminó por sí sola el fallo `status 0 / 400` en la publicación masiva.
- Hipótesis líder actual:
  - existe un subconjunto de destinatarios o una condición de fanout masivo que invalida el status completo, aunque Web muestre el eco local del story.
