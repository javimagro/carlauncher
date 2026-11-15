param(
    [string]$Ndk = 'C:/Users/javie/AppData/Local/Android/Sdk/ndk/28.2.13676358',
    [string]$GnuSysroot = 'C:/Users/javie/AppData/Local/Temp/bmw-knob-gcc7',
    [string]$Zig = 'C:/Users/javie/AppData/Local/Temp/bmw-launcher-knob-tools/ziglang/zig.exe'
)
$ErrorActionPreference = 'Stop'
$aaLlvm = Join-Path $Ndk 'toolchains/llvm/prebuilt/windows-x86_64'
$aaBuild = Join-Path ([System.IO.Path]::GetTempPath()) "bmw-aa-build-$PID"
$aaOutput = [System.IO.Path]::GetFullPath("$PSScriptRoot/../../native/javi-carlab/bin/aa-capture")
New-Item -ItemType Directory -Force -Path $aaBuild | Out-Null
$aaSources = @('aa-main.c','aa-target.c','aa-owner.c','aa-trace.c','aa-stream.c','aa-control.c','aa-sha256.c','aa-tests.c')
$aaObjects = @()
foreach ($aaFile in $aaSources) {
    $aaObject = Join-Path $aaBuild "$aaFile.o"
    & "$aaLlvm/bin/clang.exe" --target=x86_64-linux-gnu "--sysroot=$GnuSysroot" -isystem "$GnuSysroot/usr/include/x86_64-linux-gnu" -idirafter "$aaLlvm/sysroot/usr/include" -idirafter "$aaLlvm/sysroot/usr/include/x86_64-linux-android" -std=c11 -O2 -Wall -Wextra -Werror -fstack-protector-strong -fPIE -c "$PSScriptRoot/$aaFile" -o $aaObject
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $aaFile" }
    $aaObjects += $aaObject
}
& "$aaLlvm/bin/ld.lld.exe" -pie -o $aaOutput -m elf_x86_64 -dynamic-linker /lib/ld-linux-x86-64.so.2 "$GnuSysroot/usr/lib/x86_64-linux-gnu/Scrt1.o" "$GnuSysroot/usr/lib/x86_64-linux-gnu/crti.o" @aaObjects "$GnuSysroot/lib/x86_64-linux-gnu/libc-2.27.so" "$GnuSysroot/usr/lib/x86_64-linux-gnu/libc_nonshared.a" "$GnuSysroot/usr/lib/x86_64-linux-gnu/crtn.o" -z noexecstack -z relro -z now --build-id=sha1
if ($LASTEXITCODE -ne 0) { throw 'Link failed' }
$aaElfReport = & "$aaLlvm/bin/llvm-readelf.exe" -h -l -d --version-info $aaOutput
if ($LASTEXITCODE -ne 0) { throw 'ELF verification failed' }
(($aaElfReport | ForEach-Object { $_.TrimEnd() }) -join "`n").TrimEnd() | Set-Content -LiteralPath "$PSScriptRoot/ELF-CHECK.txt"
& $Zig cc -target x86_64-windows-gnu -std=c11 -O2 -Wall -Wextra -Werror -DAA_TEST_MAIN "$PSScriptRoot/aa-tests.c" "$PSScriptRoot/aa-stream.c" "$PSScriptRoot/aa-control.c" "$PSScriptRoot/aa-sha256.c" -o "$aaBuild/aa-tests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Portable tests compilation failed' }
& "$aaBuild/aa-tests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Portable tests failed' }
$aaHashes = @($aaOutput) + ($aaSources | ForEach-Object { "$PSScriptRoot/$_" }) + @("$PSScriptRoot/aa-capture.h","$PSScriptRoot/aa-platform.h")
$aaLines = foreach ($aaPath in $aaHashes) {
    $aaHash = Get-FileHash -Algorithm SHA256 -LiteralPath $aaPath
    "$($aaHash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($aaPath))"
}
$aaLines | Set-Content -LiteralPath "$PSScriptRoot/SHA256SUMS.txt"
$aaLines
