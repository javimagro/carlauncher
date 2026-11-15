"""Prepare the cockpit weather crops from the Carlinkit design assets."""

import argparse
import gzip
import json
import math
import struct
from pathlib import Path

from PIL import Image


def smooth_edge(distance, feather):
    if feather == 0:
        return 1
    t = max(0, min(1, distance / feather))
    return t * t * (3 - 2 * t)


def blend_reference(crop, visible):
    # Carlinkit's ReferenceBlend over the opaque sun and storm source crops.
    left, top, right, bottom = visible
    radius_x, radius_y = (right - left) / 2, (bottom - top) / 2
    center_x, center_y = left + radius_x, top + radius_y
    alpha = crop.getchannel('A')
    values = []
    for i, (red, green, blue, opacity) in enumerate(struct.iter_unpack('4B', crop.tobytes())):
        x, y = i % crop.width, i // crop.width
        radius = math.hypot((x - center_x) / radius_x, (y - center_y) / radius_y)
        envelope = smooth_edge(1.05 - radius, 1.05 - .20)
        light = max(min(red, green, blue), red - blue) / 255
        detail = smooth_edge(light - .16, .45 - .16)
        values.append(round(opacity * (envelope + (1 - envelope) * detail)))
    alpha.putdata(values)
    crop.putalpha(alpha)


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
        mask = entry.get("mask", {})
        edges = mask.get("feather_px", {})
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
        if mask.get('type') == 'edge_smoothstep_on_original_background':
            blend_reference(crop, entry['visible_art_bounds_in_crop_px'])
        crop.thumbnail((160, 160), Image.Resampling.LANCZOS)
        index[name] = [crop.width, crop.height, len(pixels)]
        pixels.extend(crop.tobytes())
    encoded = json.dumps(index, separators=(",", ":")).encode()
    output = Path(__file__).resolve().parent.parent / "native/javi-carlab/cockpit-weather.rgba.gz"
    output.write_bytes(gzip.compress(struct.pack("<I", len(encoded)) + encoded + pixels, mtime=0))


if __name__ == "__main__":
    main()
