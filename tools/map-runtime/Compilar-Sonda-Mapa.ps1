param(
    [Parameter(Mandatory=$true)][string]$MguFiles,
    [string]$Sysroot = "$env:TEMP/bmw-knob-gcc7",
    [string]$LlvmRoot = "$env:LOCALAPPDATA/Android/Sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/windows-x86_64",
    [string]$VsomeipHeaders = "$PSScriptRoot/../../../idrive7-apps/kit/renderd/inputgate/vsomeip-include/interface/compat",
    [string]$Output = "$PSScriptRoot/../../dist/map-manual"
)
$ErrorActionPreference = 'Stop'
foreach ($mapPath in @($MguFiles, $Sysroot, $LlvmRoot, $VsomeipHeaders)) {
    if (!(Test-Path -LiteralPath $mapPath -PathType Container)) { throw "Falta directorio requerido: $mapPath" }
}
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$mapSource = Join-Path $PSScriptRoot 'map-own-instance.cpp'
$mapObject = Join-Path $Output 'map-own-instance.o'
$mapBinary = Join-Path $Output 'map-own-instance'
& "$LlvmRoot/bin/clang.exe" --target=x86_64-linux-gnu "--sysroot=$Sysroot" -std=c++14 -O2 -fPIE -Wall -Wextra -Werror -nostdinc++ `
    -isystem "$Sysroot/usr/include/c++/7" -isystem "$Sysroot/usr/include/x86_64-linux-gnu/c++/7" -isystem $VsomeipHeaders `
    -idirafter "$LlvmRoot/sysroot/usr/include/x86_64-linux-android" -idirafter "$LlvmRoot/sysroot/usr/include" `
    -c $mapSource -o $mapObject
if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación de la sonda' }
& "$LlvmRoot/bin/ld.lld.exe" -pie --dynamic-linker=/lib/ld-linux-x86-64.so.2 -z relro -z now -o $mapBinary `
    "$Sysroot/usr/lib/x86_64-linux-gnu/Scrt1.o" "$Sysroot/usr/lib/x86_64-linux-gnu/crti.o" $mapObject `
    "$MguFiles/usr/lib/libvsomeip.so.2.99.99" "$MguFiles/usr/lib/libstdc++.so.6.0.24" "$MguFiles/lib/libgcc_s.so.1" `
    "$Sysroot/lib/x86_64-linux-gnu/libc-2.27.so" "$Sysroot/lib/x86_64-linux-gnu/libpthread-2.27.so" `
    "$Sysroot/usr/lib/x86_64-linux-gnu/libc_nonshared.a" "$Sysroot/usr/lib/x86_64-linux-gnu/crtn.o"
if ($LASTEXITCODE -ne 0) { throw 'Falló el enlace de la sonda' }
$mapElf = & "$LlvmRoot/bin/llvm-readelf.exe" -h -l -d --version-info $mapBinary
if ($LASTEXITCODE -ne 0) { throw 'Falló la inspección ELF' }
$mapElf | Set-Content -LiteralPath (Join-Path $Output 'elf.txt') -Encoding utf8
if (!(($mapElf -join "`n") -match '/lib/ld-linux-x86-64.so.2')) { throw 'Intérprete inesperado' }
@{
    sourceSha256 = (Get-FileHash -LiteralPath $mapSource -Algorithm SHA256).Hash.ToLowerInvariant()
    binarySha256 = (Get-FileHash -LiteralPath $mapBinary -Algorithm SHA256).Hash.ToLowerInvariant()
    compiler = (& "$LlvmRoot/bin/clang.exe" --version | Select-Object -First 1)
    flags = '-std=c++14 -O2 -fPIE -Wall -Wextra -Werror; Ubuntu 18.04/glibc 2.27 sysroot'
    runtimeTested = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Output 'build.json') -Encoding utf8
Write-Output "Sonda compilada, NO ejecutada: $mapBinary"
