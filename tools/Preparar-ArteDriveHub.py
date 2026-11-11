"""Prepare the reference artwork for the native renderer, which reads RGBA."""

import argparse
import gzip
import json
import struct
from pathlib import Path

from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("drivehub", type=Path)
    parser.add_argument("carlauncher_android", type=Path)
    args = parser.parse_args()
    drivehub = args.drivehub / "app/src/main"
    weather = drivehub / "res/drawable-nodpi"
    energy = args.carlauncher_android / "app/src/main/res/drawable"
    entries = {}
    pixels = bytearray()

    def add(name, image):
        image = image.convert("RGBA")
        entries[name] = [image.width, image.height, len(pixels)]
        pixels.extend(image.tobytes())

    def fitted(path, size):
        with Image.open(path) as image:
            return ImageOps.fit(image.convert("RGB"), size, method=Image.Resampling.LANCZOS)

    def thumbnail(path, size):
        with Image.open(path) as image:
            result = image.convert("RGBA")
        result.thumbnail(size, Image.Resampling.LANCZOS)
        return result

    for condition in ("sunny", "cloudy", "night", "fog", "rain", "snow", "storm"):
        add("weather-" + condition, fitted(weather / f"weather_background_{condition}.webp", (556, 468)))
        add("icon-" + condition, thumbnail(weather / f"weather_icon_{condition}.webp", (120, 120)))
    add("icon-rain-detail", thumbnail(weather / "weather_icon_rain_detail.png", (100, 100)))
    add("news", fitted(weather / "news_fanart_placeholder.webp", (368, 207)))
    station = sorted((drivehub / "assets/logos").glob("onda-cero-madrid-*"))[0]
    add("radio", fitted(station, (142, 142)))

    battery = thumbnail(energy / "bmw_battery_horizontal_transparent.webp", (112, 60))
    rgba = battery.tobytes()
    colors = {"low": (255, 59, 48), "mid": (242, 201, 76), "high": (49, 196, 109)}
    for band, (red, green, blue) in colors.items():
        tinted = battery.copy()
        tinted.putdata([
            (min(255, r + b * red // 255), min(255, g + b * green // 255), b * blue // 255, a * 153 // 255)
            for r, g, b, a in zip(rgba[0::4], rgba[1::4], rgba[2::4], rgba[3::4])
        ])
        add("battery-" + band, tinted)

    road = thumbnail(energy / "bmw_range_road_final_transparent.webp", (64, 64))
    add("range", ImageOps.pad(road, (64, 64)))

    index = json.dumps(entries, separators=(",", ":")).encode()
    archive = struct.pack("<I", len(index)) + index + pixels
    output = Path(__file__).resolve().parent.parent / "native/javi-carlab/drivehub-art.rgba.gz"
    output.write_bytes(gzip.compress(archive, compresslevel=9, mtime=0))


if __name__ == "__main__":
    main()
