# n8n en ALUMAS

Esta carpeta contiene la infraestructura versionada de `n8n` dentro del proyecto `ALUMAS`.

## Estado actual

- `n8n` funciona mediante Docker.
- El contenedor esperado es `n8n`.
- El almacenamiento persistente se conserva en el volumen externo `n8n_n8n_data`.
- Los datos internos de `n8n` no pertenecen a Git y no deben versionarse.

## Qué sí se versiona aquí

- `docker-compose.yml`
- documentación
- plantillas de entorno
- scripts auxiliares
- workflows exportados cuando empecemos a versionarlos

## Qué no se debe subir a Git

- `.env` reales
- secretos
- credenciales
- claves privadas
- `database.sqlite` u otras bases internas
- contenido de `.n8n/`

## Workflows

La carpeta `workflows/` queda preparada para guardar exportaciones JSON de workflows en el futuro.

## Opcion B Linux para WhatsApp

Ya queda versionada una primera base para la automatizacion Linux-only del envio diario:

- `scripts/alumas_whatsapp_campaign.py`
- `scripts/alumas_whatsapp_campaign.js`
- `scripts/sync_contactos_to_vps.ps1`
- `workflows/alumas_whatsapp_diario_linux_option_b.json`
- `workflows/alumas_padres_buenas_noches_2130_template.json`
- `workflows/alumas_clientes_diario_9am_evolution_template.json`

Esta base resuelve correctamente:

- el dia actual en `America/Bogota`
- la validacion de que el dia calculado coincide con el dia del sistema
- la semana comercial del mes en bloques `1-8`, `9-16`, `17-24`, `25+`
- la promocion vigente tomada desde `promociones_por_semana`
- el lote de contactos del dia desde `mensajes_por_dia`

Estado actual de esta opcion:

- el workflow queda en modo borrador
- la capa de transporte Linux para enviar por WhatsApp aun no esta implementada
- el script ya permite hacer `dry-run` y validar la logica diaria sin depender de Windows
- los workflows operativos que usen numeros privados o tokens reales deben desplegarse con esos valores solo dentro de `n8n`, no en Git

## Fuente operativa de contactos

El archivo canónico sigue siendo el `contactos.json` del sistema actual de Windows.

- el editor local sigue siendo el punto de edición y actualización desde BD/API
- el VPS usa una copia sincronizada en `n8n/runtime/contactos.json`
- el token operativo de Evolution para los workflows se guarda fuera de Git en `n8n/runtime/evolution_instance_token.txt`
- el script `scripts/sync_contactos_to_vps.ps1` valida y copia ese archivo al VPS sin subirlo a Git

### Requisito pendiente para ejecutar desde n8n

Como `n8n` corre en Docker, el nodo `Execute Command` se ejecuta dentro del contenedor, no en el host. Antes de activar este workflow, el contenedor debe poder ver:

- el script `scripts/alumas_whatsapp_campaign.py`
- una ruta persistente con `contactos.json`
- la futura capa Linux de envio

## Acceso actual

Por ahora el acceso es temporalmente por HTTP e IP:

- `http://72.62.166.253:5678`

La variable `N8N_SECURE_COOKIE=false` se mantiene solo para aprendizaje y acceso temporal sin HTTPS.

## Próximo paso recomendado

Antes de pasar a producción, debemos migrar el acceso a HTTPS y revisar la configuración de cookies seguras, dominio y webhook URL.
