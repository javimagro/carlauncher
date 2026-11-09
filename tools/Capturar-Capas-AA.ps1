param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.:-]*$')][string]$Destino,
    [Parameter(Mandatory)][string]$Identidad,
    [ValidateRange(1,65535)][int]$Puerto = 22
)

$ErrorActionPreference = 'Stop'
$clave = (Resolve-Path -LiteralPath $Identidad).Path
$consulta = @'
printf '%s\n' '--- Contexto iDrive ---'
if [ -x /var/opt/iteriodev-overlays/current/hmictl ]; then
    { printf 'ctx\n'; sleep 2; } | /var/opt/iteriodev-overlays/current/hmictl serve
fi
printf '%s\n' '--- Capas de Winston ---'
XDG_RUNTIME_DIR=/run/wayland WAYLAND_DISPLAY=wayland-0 /usr/bin/ivi-control scene
'@

$consulta.Replace("`r`n", "`n") | & ssh.exe -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes `
    -o ConnectTimeout=5 -p $Puerto -i $clave "root@$Destino" 'sh -s'
if ($LASTEXITCODE -ne 0) { throw "La consulta de capas termino con codigo $LASTEXITCODE." }
