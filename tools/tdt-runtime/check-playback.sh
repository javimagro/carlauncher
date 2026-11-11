#!/bin/sh
set -eu

decoder=$(realpath "$1")
work=$(mktemp -d)
cd "$work"
trap 'kill "$server" 2>/dev/null || true' EXIT

ffmpeg -nostdin -loglevel error -f lavfi -i testsrc2=size=320x180:rate=12 \
    -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -g 12 -c:a aac sample.mp4
ffmpeg -nostdin -loglevel error -i sample.mp4 -c copy -hls_time 1 -f hls test.m3u8
ffmpeg -nostdin -loglevel error -i sample.mp4 -c copy -seg_duration 1 -f dash test.mpd
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext 'subjectAltName=DNS:localhost' -keyout key.pem -out cert.pem 2>/dev/null

python3 - <<'PY' &
import http.server
import ssl
from pathlib import Path

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("cert.pem", "key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
Path("port").write_text(str(server.server_port))
server.serve_forever()
PY
server=$!
for _ in $(seq 1 30); do
    test ! -s port || break
    sleep .1
done
port=$(cat port)
export SSL_CERT_FILE="$work/cert.pem"

for stream in test.m3u8 test.mpd; do
    if ! "$decoder" -nostdin -hide_banner -loglevel quiet -rw_timeout 8000000 -tls_verify 1 \
        -protocol_whitelist http,https,tcp,tls,httpproxy,crypto -re -i "https://localhost:$port/$stream" \
        -map 0:v:0 -an -t 1 -vf 'fps=20,scale=640:360:force_original_aspect_ratio=decrease:out_color_matrix=bt709,pad=640:360:(ow-iw)/2:(oh-ih)/2' \
        -pix_fmt yuv420p -f rawvideo pipe:1 \
        -map 0:a:0 -vn -t 1 -ac 2 -ar 48000 -f s16le pipe:2 >video.i420 2>audio.pcm; then
        "$decoder" -nostdin -loglevel error -tls_verify 1 -i "https://localhost:$port/$stream" \
            -map 0:v:0 -an -t 1 -pix_fmt yuv420p -f rawvideo -y probe.i420 || true
        exit 1
    fi
    test "$(wc -c <video.i420)" -eq 6912000
    test "$(wc -c <audio.pcm)" -eq 192000
    printf '%s: I420 + PCM por HTTPS\n' "$stream"
done
