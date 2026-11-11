#!/bin/sh
set -eu

out=$(pwd)/tdt-runtime-build
mkdir -p "$out"
apk add --no-cache build-base ca-certificates curl linux-headers nasm pkgconf \
    openssl-dev openssl-libs-static libxml2-dev libxml2-static zlib-dev zlib-static xz-dev xz-static

work=$(mktemp -d)
cd "$work"
curl -fsSL --retry 3 https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n9.0.2 -o ffmpeg.tar.gz
echo '6e374ed621e48faa40639307dff48ba6fe574a509977956d2cce9669b7cc27e9  ffmpeg.tar.gz' | sha256sum -c -
tar -xf ffmpeg.tar.gz
cd FFmpeg-n9.0.2

./configure --arch=x86_64 --cpu=generic --pkg-config-flags=--static --extra-ldflags=-static \
    --disable-everything --disable-autodetect --disable-doc --disable-debug \
    --disable-ffplay --disable-ffprobe --disable-avdevice \
    --enable-version3 --enable-openssl --enable-libxml2 --enable-zlib \
    --enable-protocol=file,pipe,http,https,tcp,tls,httpproxy,crypto \
    --enable-demuxer=hls,dash,mpegts,mov,aac,mp3,matroska,flv,webvtt \
    --enable-decoder=h264,hevc,mpeg2video,aac,aac_latm,mp3,mp2,ac3,eac3,opus,vorbis,vp8,vp9,av1,rawvideo,pcm_s16le,webvtt \
    --enable-parser=h264,hevc,mpegvideo,aac,aac_latm,mpegaudio,ac3,opus,vorbis,vp8,vp9,av1 \
    --enable-muxer=rawvideo,pcm_s16le \
    --enable-encoder=rawvideo,pcm_s16le \
    --enable-filter=fps,scale,pad,format,aformat,aresample,anull,null,trim,atrim,setpts,asetpts
make -j "$(nproc)" ffmpeg
install -m755 ffmpeg "$out/ffmpeg"
install -m644 /etc/ssl/certs/ca-certificates.crt "$out/ca-certificates.crt"
install -m644 COPYING.LGPLv3 "$out/FFmpeg-LGPLv3.txt"
install -m644 COPYING.GPLv3 "$out/FFmpeg-GPLv3.txt"
apk list --installed musl libcrypto3 libssl3 libxml2 zlib xz-libs ca-certificates-bundle > "$out/alpine-versions.txt"
