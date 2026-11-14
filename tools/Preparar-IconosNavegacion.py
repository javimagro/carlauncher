"""Rasterize the user's Carlinkit Android vectors with Windows WPF, then pack RGBA.

Only a PC build tool: no XML parsing/rasterization or new runtime dependency on MGU.
"""
import argparse
import gzip
import json
import struct
import subprocess
from pathlib import Path
from PIL import Image, ImageColor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = root / 'dist/navigation-icons'
    subprocess.run(['pwsh', '-NoProfile', '-STA', '-File', str(root / 'tools/Exportar-VectoresNavegacion.ps1'),
                    '-Drawable', str(args.reference / 'app/src/main/res/drawable'), '-Output', str(output)], check=True)
    sources = json.loads((output / 'sources.json').read_text(encoding='utf-8-sig'))
    entries, pixels = {}, bytearray()
    colors = ['182A3E', '506278', '183D68', 'F4F7FB', 'C7D4E1', 'A82E37', 'FFADB6', '27623D', '9ED4AE', '885800', 'F6C57A']
    for name in sorted(sources):
        with Image.open(output / (name + '.png')) as image:
            alpha = image.convert('RGBA').getchannel('A')
        for color in colors:
            tinted = Image.new('RGBA', alpha.size, ImageColor.getrgb('#' + color))
            tinted.putalpha(alpha)
            entries[name + '-' + color] = [tinted.width, tinted.height, len(pixels)]
            pixels.extend(tinted.tobytes())
    encoded = json.dumps(entries, separators=(',', ':')).encode()
    packed = gzip.compress(struct.pack('<I', len(encoded)) + encoded + pixels, mtime=0)
    (root / 'native/javi-carlab/navigation-icons.rgba.gz').write_bytes(packed)
    metadata = {'source': 'BMWLauncher Android (Carlinkit), user-owned reference', 'conversion': 'Windows WPF 72 px alpha, monochrome Android tint', 'files': sources}
    (root / 'native/javi-carlab/navigation-icons.SOURCES.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(f'{len(sources)} reference vectors, {len(entries)} tinted images, {len(packed)} bytes packed')


if __name__ == '__main__':
    main()
