"""Prepare the cockpit weather crops from the Carlinkit design assets."""

import argparse
import gzip
import json
import struct
from pathlib import Path

from PIL import Image


def smooth_edge(distance, feather):
    if feather == 0:
        return 1
    t = max(0, min(1, distance / feather))
    return t * t * (3 - 2 * t)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("carlauncher_android", type=Path)
    args = parser.parse_args()
    directory = args.carlauncher_android / "app/src/main/assets/cockpit/weather"
    manifest = json.loads((directory / "weather_atlas.json").read_text(encoding="utf-8"))
    index = {}
    pixels = bytearray()
    for name, entry in manifest["entries"].items():
        rect = entry["source_rect_px"]
        with Image.open(directory / entry["source"]) as source:
            crop = source.crop(tuple(rect[side] for side in ("left", "top", "right", "bottom"))).convert("RGBA")
        edges = entry.get("mask", {}).get("feather_px", {})
        if edges:
            alpha = crop.getchannel("A")
            w, h = crop.size
            alpha.putdata([
                round(a * smooth_edge(x, edges.get("left", 0)) *
                      smooth_edge(w - 1 - x, edges.get("right", 0)) *
                      smooth_edge(y, edges.get("top", 0)) *
                      smooth_edge(h - 1 - y, edges.get("bottom", 0)))
                for i, a in enumerate(alpha.tobytes()) for x, y in [(i % w, i // w)]
            ])
            crop.putalpha(alpha)
        crop.thumbnail((160, 160), Image.Resampling.LANCZOS)
        index[name] = [crop.width, crop.height, len(pixels)]
        pixels.extend(crop.tobytes())
    encoded = json.dumps(index, separators=(",", ":")).encode()
    output = Path(__file__).resolve().parent.parent / "native/javi-carlab/cockpit-weather.rgba.gz"
    output.write_bytes(gzip.compress(struct.pack("<I", len(encoded)) + encoded + pixels, mtime=0))


if __name__ == "__main__":
    main()
