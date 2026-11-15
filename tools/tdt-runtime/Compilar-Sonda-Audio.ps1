#Requires -Version 5.1
param(
  [Parameter(Mandatory=$true)][string]$PrivateRoot,
  [string]$Sysroot = "$env:TEMP/bmw-knob-gcc7",
  [string]$Llvm = "$env:LOCALAPPDATA/Android/Sdk/ndk/28.2.13676358/toolchains/llvm/prebuilt/windows-x86_64",
  [string]$VsomeipInclude = "$PSScriptRoot/../../../idrive7-apps/kit/renderd/inputgate/vsomeip-include/interface/compat",
  [string]$OutputDirectory = "$PSScriptRoot/../../dist/audio-probe",
  [string]$AudioFixture = ''
)
$ErrorActionPreference = 'Stop'
$sourceFile = Join-Path $PSScriptRoot 'probe-dynamic-audio.cpp'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$objectFile = Join-Path $OutputDirectory 'probe-dynamic-audio.o'
$binaryFile = Join-Path $OutputDirectory 'probe-dynamic-audio'
& "$Llvm/bin/clang.exe" --target=x86_64-linux-gnu "--sysroot=$Sysroot" -std=c++14 -O2 -fPIE -Wall -Wextra -Werror -nostdinc++ -isystem "$Sysroot/usr/include/c++/7" -isystem "$Sysroot/usr/include/x86_64-linux-gnu/c++/7" -isystem $VsomeipInclude -idirafter "$Llvm/sysroot/usr/include/x86_64-linux-android" -idirafter "$Llvm/sysroot/usr/include" -c $sourceFile -o $objectFile
if ($LASTEXITCODE -ne 0) { throw 'Audio probe compilation failed' }
& "$Llvm/bin/ld.lld.exe" -pie --dynamic-linker=/lib/ld-linux-x86-64.so.2 -z relro -z now -o $binaryFile "$Sysroot/usr/lib/x86_64-linux-gnu/Scrt1.o" "$Sysroot/usr/lib/x86_64-linux-gnu/crti.o" $objectFile "$PrivateRoot/files/usr/lib/libvsomeip.so.2.99.99" "$PrivateRoot/files/usr/lib/libstdc++.so.6.0.24" "$PrivateRoot/files/lib/libgcc_s.so.1" "$Sysroot/lib/x86_64-linux-gnu/libc-2.27.so" "$Sysroot/lib/x86_64-linux-gnu/libpthread-2.27.so" "$Sysroot/usr/lib/x86_64-linux-gnu/libc_nonshared.a" "$Sysroot/usr/lib/x86_64-linux-gnu/crtn.o"
if ($LASTEXITCODE -ne 0) { throw 'Audio probe link failed' }
$elf = & "$Llvm/bin/llvm-readelf.exe" -h -l -d --version-info $binaryFile
if ($LASTEXITCODE -ne 0) { throw 'Audio probe ELF inspection failed' }
$elf | Set-Content -LiteralPath (Join-Path $OutputDirectory 'elf.txt') -Encoding utf8
if (!(($elf -join "`n") -match '/lib/ld-linux-x86-64.so.2')) { throw 'Unexpected ELF interpreter' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Inspeccionar-Audio-Propio.js') -Destination $OutputDirectory
$fixtureHash = $null
if ($AudioFixture) {
  $fixture = Get-Item -LiteralPath $AudioFixture
  if ($fixture.PSIsContainer -or $fixture.Length -lt 44 -or $fixture.Length -gt 2MB) { throw 'Invalid fixture size' }
  Copy-Item -LiteralPath $AudioFixture -Destination (Join-Path $OutputDirectory 'audio-probe.wav')
  $fixtureHash = (Get-FileHash -LiteralPath $AudioFixture -Algorithm SHA256).Hash.ToLowerInvariant()
}
@{
  sourceSha256 = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
  inspectorSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'Inspeccionar-Audio-Propio.js') -Algorithm SHA256).Hash.ToLowerInvariant()
  binarySha256 = (Get-FileHash -LiteralPath $binaryFile -Algorithm SHA256).Hash.ToLowerInvariant()
  fixtureSha256 = $fixtureHash
  compiler = (& "$Llvm/bin/clang.exe" --version | Select-Object -First 1)
  flags = '-std=c++14 -O2 -fPIE -Wall -Wextra -Werror; GCC 7/glibc 2.27 sysroot'
  runtimeTested = $false
  audibleTested = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build.json') -Encoding utf8
Write-Output "Audio probe compiled, NOT run: $binaryFile"
