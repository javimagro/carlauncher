param(
    [Parameter(Mandatory)][string]$Ndk,
    [Parameter(Mandatory)][string]$GnuSysroot,
    [Parameter(Mandatory)][string]$VsSomeIp
)

$ErrorActionPreference = 'Stop'
$llvm = Join-Path $Ndk 'toolchains/llvm/prebuilt/windows-x86_64'
$kernel = Join-Path $llvm 'sysroot/usr/include'
$bin = Join-Path $llvm 'bin'
$source = (Resolve-Path "$PSScriptRoot/../../native/javi-ccu-gate").Path
$object = Join-Path ([System.IO.Path]::GetTempPath()) "javi-ccu-gate-$PID.o"
$glibc = Join-Path $GnuSysroot 'lib/x86_64-linux-gnu'

try {
    & "$bin/clang.exe" --target=x86_64-linux-gnu "--sysroot=$GnuSysroot" -std=c++14 -O2 -fPIC `
        -fvisibility=hidden -fno-exceptions -fno-rtti -Wall -Wextra -Werror -nostdinc++ `
        -isystem "$GnuSysroot/usr/include/c++/7" -isystem "$GnuSysroot/usr/include/x86_64-linux-gnu/c++/7" `
        -isystem "$VsSomeIp/interface/compat" -idirafter "$kernel/x86_64-linux-android" -idirafter "$kernel" `
        -c "$source/gate.cpp" -o "$object"
    if ($LASTEXITCODE -ne 0) { throw 'Error al compilar el filtro de FrontCCU' }
    & "$bin/ld.lld.exe" -shared -z defs -z relro -z now --build-id=sha1 --soname=javi-ccu-gate.so `
        -o "$source/javi-ccu-gate.so" "$object" "$glibc/libc-2.27.so" "$glibc/libdl-2.27.so" "$glibc/libpthread-2.27.so"
    if ($LASTEXITCODE -ne 0) { throw 'Error al enlazar el filtro de FrontCCU' }
} finally {
    if (Test-Path -LiteralPath $object) { Remove-Item -LiteralPath $object }
}
