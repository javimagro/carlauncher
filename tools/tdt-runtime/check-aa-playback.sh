#!/bin/sh
set -eu

decoder=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -f "$work/input.h264" "$work/output.i420"; rmdir "$work"' EXIT

# Synthetic MAIN-sized input. Never upload recordings from the user's phone.
ffmpeg -nostdin -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=50 \
    -t 3 -an -c:v libx264 -preset ultrafast -profile:v baseline -g 50 \
    -f h264 "$work/input.h264"
"$decoder" -nostdin -hide_banner -loglevel error -threads 1 -f h264 -r 50 -i "$work/input.h264" \
    -an -vf 'fps=20,crop=1920:560:0:260,scale=960:280' -pix_fmt yuv420p \
    -f rawvideo "$work/output.i420"
bytes=$(wc -c < "$work/output.i420")
test "$((bytes % 403200))" -eq 0
frames=$((bytes / 403200))
test "$frames" -ge 58
test "$frames" -le 61
printf 'AA synthetic 1080p: %s complete I420 frames\n' "$frames"
