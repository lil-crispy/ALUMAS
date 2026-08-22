param(
    [string]$SourcePath = "G:\Mi unidad\ALUMAS_RECUPERADO\contactos.json",
    [string]$VpsHost = "72.62.166.253",
    [string]$User = "root",
    [string]$RemotePath = "/var/www/alumas/n8n/runtime/contactos.json"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "No existe el archivo fuente: $SourcePath"
}

$raw = Get-Content -LiteralPath $SourcePath -Raw -Encoding UTF8
$json = $raw | ConvertFrom-Json

if (-not $json.mensajes_por_dia) {
    throw "El JSON no contiene mensajes_por_dia"
}

if (-not $json.promociones_por_semana) {
    throw "El JSON no contiene promociones_por_semana"
}

$remoteDir = Split-Path -Path $RemotePath -Parent
$tmpRemote = "$RemotePath.tmp"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRemote = "/var/www/alumas/n8n/runtime-backup/contactos-$timestamp.json"

ssh "$User@$VpsHost" "mkdir -p '$remoteDir' '/var/www/alumas/n8n/runtime-backup' '/var/www/alumas/n8n/runtime/logs'"

if ((ssh "$User@$VpsHost" "test -f '$RemotePath' && echo yes || echo no").Trim() -eq "yes") {
    ssh "$User@$VpsHost" "cp '$RemotePath' '$backupRemote'"
}

scp "$SourcePath" "${User}@${VpsHost}:$tmpRemote"
ssh "$User@$VpsHost" "python3 - <<'PY'
import json
from pathlib import Path
path = Path('$tmpRemote')
data = json.loads(path.read_text(encoding='utf-8'))
assert 'mensajes_por_dia' in data
assert 'promociones_por_semana' in data
print('JSON_OK')
PY"

ssh "$User@$VpsHost" "mv '$tmpRemote' '$RemotePath'"

$days = ($json.mensajes_por_dia.PSObject.Properties.Name | Sort-Object) -join ", "
Write-Host "Sincronizacion completada."
Write-Host "Origen: $SourcePath"
Write-Host "Destino: $RemotePath"
Write-Host "Dias disponibles: $days"
