param(
    [string]$Kit = (Join-Path (Split-Path -Parent $PSScriptRoot) 'idrive7-apps'),
    [ValidateRange(1, 65535)][int]$Port = 8077
)

$ErrorActionPreference = 'Stop'
$revision = '21c65786a6c4d23bd54e706b6c46722ffa24a077'
$patch = Join-Path $PSScriptRoot 'tools/idrive-kit-windows.patch'
$id = 'javi_carlauncher_preview'

Get-Command git, node, python | Out-Null
if (-not (Test-Path -LiteralPath $Kit -PathType Container)) {
    throw "Falta el kit local en $Kit. Consulta el apartado de emulación del README."
}
$actual = git -C $Kit rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actual -ne $revision) {
    throw "El adaptador requiere la revisión $revision de idrive7-apps."
}

git -C $Kit apply --reverse --check --quiet $patch 2>$null
if ($LASTEXITCODE -ne 0) {
    git -C $Kit apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'El parche de Windows no encaja en la copia local.' }
    git -C $Kit apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el simulador para Windows.' }
}

# El kit genera su dist por separado.
$app = Join-Path $Kit "apps/$id"
New-Item -ItemType Directory -Path $app -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'emulator/app.json'), (Join-Path $PSScriptRoot 'emulator/main.js'), (Join-Path $PSScriptRoot 'emulator/launcher-view.js') -Destination $app

$url = "http://127.0.0.1:$Port/"
$browserOpened = $false
Write-Host "Simulador grafico local en $url (Ctrl+C para parar)."
Push-Location -LiteralPath $Kit
try {
    node kit/tools/emu.js $id --port $Port | ForEach-Object {
        Write-Output $_
        if (-not $browserOpened -and $_.TrimStart().StartsWith("renderer: $id connected")) {
            $browserOpened = $true
            try {
                Start-Process -FilePath $url
            } catch {
                Write-Warning "Abre $url en el navegador."
            }
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "El simulador termino con codigo $LASTEXITCODE." }
} finally {
    Pop-Location
}
