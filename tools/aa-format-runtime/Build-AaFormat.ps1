param(
    [Parameter(Mandatory=$true)][string]$Ndk,
    [Parameter(Mandatory=$true)][string]$GnuSysroot,
    [Parameter(Mandatory=$true)][string]$Zig,
    [string]$BuildDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) "javi-aa-format-$PID"),
    [string]$Output = "$PSScriptRoot/../../native/javi-aa-format/javi-aa-format.so",
    [switch]$EnableWrites
)
$ErrorActionPreference = 'Stop'
$bridgeLlvm = Join-Path $Ndk 'toolchains/llvm/prebuilt/windows-x86_64'
$bridgeOwnSources = [System.IO.Path]::GetFullPath("$PSScriptRoot/../aa-runtime")
$bridgeEnabled = if ($EnableWrites) { '1' } else { '0' }
$bridgeBuild = [System.IO.Path]::GetFullPath($BuildDirectory)
$bridgeOutput = [System.IO.Path]::GetFullPath($Output)
$bridgeFiles = @('bridge-state.c','bridge-baseline.c','bridge-protocol.c','bridge-diag.c','bridge-hooks.c','bridge-guard.c','bridge-server.c')
$bridgeTests = @('test-state.c','test-baseline.c','test-profile.c','test-protocol.c')
foreach ($bridgeRequired in @("$bridgeLlvm/bin/clang.exe", "$bridgeLlvm/bin/ld.lld.exe", "$bridgeLlvm/bin/llvm-readelf.exe", $Zig, "$GnuSysroot/lib/x86_64-linux-gnu/libc-2.27.so")) {
    if (-not (Test-Path -LiteralPath $bridgeRequired -PathType Leaf)) { throw "Required existing toolchain file missing: $bridgeRequired" }
}
New-Item -ItemType Directory -Force -Path $bridgeBuild | Out-Null
$bridgeObjects = @()
foreach ($bridgeFile in $bridgeFiles + @('aa-sha256.c')) {
    $bridgeSource = if ($bridgeFile -eq 'aa-sha256.c') { "$bridgeOwnSources/$bridgeFile" } else { "$PSScriptRoot/$bridgeFile" }
    $bridgeObject = Join-Path $bridgeBuild "$bridgeFile.o"
    & "$bridgeLlvm/bin/clang.exe" --target=x86_64-linux-gnu "--sysroot=$GnuSysroot" -isystem "$GnuSysroot/usr/include/x86_64-linux-gnu" -idirafter "$bridgeLlvm/sysroot/usr/include" -idirafter "$bridgeLlvm/sysroot/usr/include/x86_64-linux-android" -I $bridgeOwnSources "-DBM_ENABLE_WRITES=$bridgeEnabled" -DBM_DAEMON_UID=13006 -DBM_DAEMON_GID=13006 -std=c11 -O2 -Wall -Wextra -Werror -fstack-protector-strong -fPIC -fvisibility=hidden -c $bridgeSource -o $bridgeObject
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $bridgeFile" }
    $bridgeObjects += $bridgeObject
}
$bridgeBinary = Join-Path $bridgeBuild 'javi-aa-format.so'
& "$bridgeLlvm/bin/ld.lld.exe" -shared -o $bridgeBinary -m elf_x86_64 @bridgeObjects "$GnuSysroot/lib/x86_64-linux-gnu/libc-2.27.so" "$GnuSysroot/lib/x86_64-linux-gnu/libpthread-2.27.so" "$GnuSysroot/lib/x86_64-linux-gnu/libdl-2.27.so" -soname javi-aa-format.so -z defs -z noexecstack -z relro -z now -z nodelete --build-id=sha1
if ($LASTEXITCODE -ne 0) { throw 'Link failed' }
$bridgeReport = & "$bridgeLlvm/bin/llvm-readelf.exe" -h -l -d --version-info --dyn-syms $bridgeBinary
if ($LASTEXITCODE -ne 0) { throw 'ELF inspection failed' }
$bridgeReportText = (($bridgeReport | ForEach-Object { $_.TrimEnd() }) -join "`n").TrimEnd()
if ($bridgeReportText -notmatch 'ELF64' -or $bridgeReportText -notmatch 'Advanced Micro Devices X86-64' -or $bridgeReportText -notmatch 'NODELETE') { throw 'Wrong ELF architecture or lifetime flags' }
$bridgeVersions = [regex]::Matches($bridgeReportText, 'GLIBC_(\d+\.\d+)') | ForEach-Object { [version]$_.Groups[1].Value }
if (-not $bridgeVersions -or ($bridgeVersions | Where-Object { $_ -gt [version]'2.17' })) { throw 'Unsupported GLIBC requirement' }
$bridgeTestSources = @('bridge-state.c','bridge-baseline.c','bridge-protocol.c') + $bridgeTests | ForEach-Object { "$PSScriptRoot/$_" }
& $Zig cc -target x86_64-windows-gnu -std=c11 -O2 -Wall -Wextra -Werror -DBM_DAEMON_UID=13006 -DBM_DAEMON_GID=13006 @bridgeTestSources -o "$bridgeBuild/test-state.exe"
if ($LASTEXITCODE -ne 0) { throw 'Model tests compilation failed' }
$bridgeTestOutput = & "$bridgeBuild/test-state.exe"
if ($LASTEXITCODE -ne 0) { throw "Model tests failed: $bridgeTestOutput" }
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($bridgeOutput)) | Out-Null
if ($bridgeBinary -ne $bridgeOutput) { Copy-Item -LiteralPath $bridgeBinary -Destination $bridgeOutput -Force }
$bridgeReportText | Set-Content -LiteralPath "$PSScriptRoot/ELF-CHECK.txt" -Encoding ascii
@("BM_DAEMON_UID=13006", "BM_DAEMON_GID=13006", "BM_ENABLE_WRITES=$bridgeEnabled", 'PROTOCOL=3', 'MARKER=javi-aa-format/1.0.0') | Set-Content -LiteralPath "$bridgeBuild/PROFILE.txt" -Encoding ascii
$bridgeTestOutput | Set-Content -LiteralPath "$bridgeBuild/TESTS.txt" -Encoding ascii
$bridgeHashes = @($bridgeOutput) + ($bridgeFiles + $bridgeTests | ForEach-Object { "$PSScriptRoot/$_" }) + @("$bridgeOwnSources/aa-sha256.c", "$bridgeOwnSources/aa-capture.h") + @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.h' | Sort-Object Name | ForEach-Object { $_.FullName })
$bridgeLines = foreach ($bridgePath in $bridgeHashes) {
    $bridgeHash = Get-FileHash -Algorithm SHA256 -LiteralPath $bridgePath
    "$($bridgeHash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($bridgePath))"
}
$bridgeLines | Set-Content -LiteralPath "$PSScriptRoot/SHA256SUMS.txt" -Encoding ascii
$bridgeTestOutput
$bridgeLines[0]
"Build outputs: $bridgeBuild"
