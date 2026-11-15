"""Pack the local Carlinkit TDTWorld logos for the iDrive renderer."""
import argparse
import base64
import hashlib
import json
import re
import struct
import subprocess
import tempfile
import unicodedata
import urllib.parse
import zlib
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


SIZE = 90
COUNTRIES = ('es', 'pt', 'de', 'fr', 'it', 'uk')
ASSET_PREFIX = 'asset:tv_logos/'
GENERIC = 'channel_placeholder.webp'


def key(text):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFD', text).lower())


def name_key(text):
    return key(re.sub(r'\(\d+p\)|\[[^\]]+\]', '', text, flags=re.I))


def url_key(text):
    url = urllib.parse.urlsplit(text)
    return hashlib.sha256((url.hostname + urllib.parse.unquote(url.path)).encode()).hexdigest()


def read_catalog(path):
    with path.open('rb') as source:
        magic, version, count = struct.unpack('>III', source.read(12))
        if magic != 0x54444348 or version != 1 or count > 10000:
            raise ValueError(f'Unexpected TDTWorld catalogue {path.name}')
        for _ in range(count):
            fields = [source.read(struct.unpack('>I', source.read(4))[0]).decode() for _ in range(11)]
            name, _, epg, label, logo, *_ = fields
            yield name, epg, label, logo
        if source.read(1):
            raise ValueError(f'Trailing data in {path.name}')


def rasterize_svg(path, chrome):
    if not chrome:
        raise ValueError('Algunos logos de Carlinkit son SVG. Indica --chrome para convertirlos en PC.')
    with tempfile.TemporaryDirectory(prefix='tdt-logo-svg-') as work:
        work = Path(work)
        page = work / 'logo.html'
        png = work / 'logo.png'
        svg = base64.b64encode(path.read_bytes()).decode('ascii')
        page.write_text(f'<style>body{{margin:0}} img{{width:{SIZE}px;height:{SIZE}px;object-fit:contain}}</style>'
                        f'<img src="data:image/svg+xml;base64,{svg}">', encoding='ascii')
        subprocess.run([str(chrome), '--headless', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1',
                        '--default-background-color=00000000', f'--window-size={SIZE},{SIZE}',
                        f'--user-data-dir={work / "chrome"}', f'--screenshot={png}', page.as_uri()],
                       check=True, timeout=45, capture_output=True)
        with Image.open(png) as image:
            return image.convert('RGBA').crop((0, 0, SIZE, SIZE))


def pixels(path, chrome):
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source).convert('RGBA')
    except UnidentifiedImageError:
        if b'<svg' not in path.read_bytes()[:2048]:
            raise
        return rasterize_svg(path, chrome).tobytes()
    image.thumbnail((SIZE, SIZE), Image.Resampling.LANCZOS)
    square = Image.new('RGBA', (SIZE, SIZE))
    square.paste(image, ((SIZE - image.width) // 2, (SIZE - image.height) // 2))
    return square.tobytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path, help='TDTWorld Android checkout for Carlinkit')
    parser.add_argument('--chrome', type=Path, help='Chromium executable used to rasterize SVG logos')
    args = parser.parse_args()
    assets = args.reference / 'app/src/main/assets'
    directory = assets / 'tv_logos'
    catalogue = assets / 'channel_catalog'
    source_index = json.loads((directory / 'index.json').read_text(encoding='utf-8'))
    source_urls = json.loads((catalogue / 'downloaded_logo_map.json').read_text(encoding='utf-8'))

    pack = bytearray()
    indexes, offsets, seen = {}, [], {}
    for file in sorted(directory.iterdir()):
        if not file.is_file() or file.name == 'index.json':
            continue
        data = pixels(file, args.chrome)
        digest = hashlib.sha256(data).digest()
        if digest not in seen:
            blob = zlib.compress(data, 9)
            seen[digest] = len(offsets)
            offsets.append([len(pack), len(blob)])
            pack.extend(blob)
        indexes[file.name] = seen[digest]

    local = {key(row['key']): indexes[row['file']] for row in source_index}
    urls = {url_key(url): indexes[file] for url, file in source_urls.items()}
    regions = {}
    channel_counts = {}
    for country in COUNTRIES:
        aliases = {}
        count = 0
        for name, epg, label, logo in read_catalog(catalogue / f'channels_{country}.bin'):
            if logo.startswith(ASSET_PREFIX):
                asset = indexes[logo.removeprefix(ASSET_PREFIX)]
            else:
                asset = urls.get(url_key(logo), indexes[GENERIC]) if logo else indexes[GENERIC]
            for alias in (key(epg), key(epg.split('@')[0]), key(name), name_key(name), key(label)):
                if alias and (alias not in aliases or aliases[alias] == indexes[GENERIC]):
                    aliases[alias] = asset
            count += 1
        regions[country] = aliases
        channel_counts[country] = count

    output = Path(__file__).resolve().parent.parent / 'native/javi-carlab'
    commit = subprocess.check_output(['git', '-C', str(args.reference), 'rev-parse', 'HEAD'], text=True).strip()
    index = {'source': {'project': 'TDTWorld Android (Carlinkit)', 'commit': commit, 'files': len(indexes),
                        'channels': channel_counts, 'sha256': hashlib.sha256(pack).hexdigest()},
             'size': SIZE, 'generic': indexes[GENERIC], 'offsets': offsets,
             'regions': regions, 'local': local, 'urls': urls}
    (output / 'tdt-logos.pack').write_bytes(pack)
    (output / 'tdt-logos.json').write_text(json.dumps(index, ensure_ascii=True, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'{len(indexes)} logos originales, {len(offsets)} imágenes distintas, {sum(channel_counts.values())} canales, {len(pack)} bytes')


if __name__ == '__main__':
    main()
