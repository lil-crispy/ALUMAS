# Evolution API en ALUMAS

Esta carpeta contiene la infraestructura versionada para ejecutar `Evolution API` junto a `n8n` dentro del proyecto `ALUMAS`.

## Objetivo

- exponer un gateway de WhatsApp para que `n8n` pueda enviar mensajes desde Linux
- mantener la configuracion versionada en Git
- mantener secretos y sesiones fuera de Git
- aislar Evolution de `ALUMAS` y de la instancia actual de `n8n`

## Arquitectura

- `evolution_api` corre con la imagen oficial
- `evolution_postgres` guarda la persistencia de Evolution
- `evolution_redis` se usa para cache
- `evolution_api` se conecta tambien a la red externa `n8n_default`

Con esto, `n8n` puede llamar a Evolution por el hostname interno `http://evolution_api:8080` sin necesidad de tocar Nginx.

## Puertos

- El puerto del contenedor es `8080`
- En el host se publica por defecto como `127.0.0.1:8081`

Esto evita conflicto con el backend de ALUMAS que ya usa `:8080`.

## Variables sensibles

No subir a Git:

- `.env`
- API keys reales
- contrasenas de PostgreSQL
- sesiones de WhatsApp

Versionar solo `.env.example`.

## Despliegue esperado

1. Crear `.env` a partir de `.env.example`
2. Ejecutar `docker compose config`
3. Ejecutar `docker compose up -d`
4. Verificar `docker ps`
5. Probar la API con el header `apikey`

## Integracion con n8n

La URL interna recomendada para `n8n` es:

- `http://evolution_api:8080`

La autenticacion se realiza con el header:

- `apikey`

## Siguiente paso

Despues de levantar Evolution, hay que:

1. crear una instancia de WhatsApp
2. obtener el QR
3. vincular el numero
4. probar el envio de un mensaje simple
5. conectar el workflow diario de ALUMAS con esa instancia
