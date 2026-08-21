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

## Acceso actual

Por ahora el acceso es temporalmente por HTTP e IP:

- `http://72.62.166.253:5678`

La variable `N8N_SECURE_COOKIE=false` se mantiene solo para aprendizaje y acceso temporal sin HTTPS.

## Próximo paso recomendado

Antes de pasar a producción, debemos migrar el acceso a HTTPS y revisar la configuración de cookies seguras, dominio y webhook URL.
