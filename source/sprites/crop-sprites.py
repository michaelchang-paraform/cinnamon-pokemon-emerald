# needs Pillow; crops the PokeAPI downloads to their opaque bounds
from pathlib import Path
from PIL import Image

here = Path(__file__).resolve().parent
src = here / 'download'
jobs = {
    'mudkip.png': 'emerald-258.png',
    'treecko.png': 'emerald-252.png',
    'torchic.png': 'emerald-255.png',
}
for out, name in jobs.items():
    im = Image.open(src / name).convert('RGBA')
    im.crop(im.getbbox()).save(here / out)
    print(out, im.getbbox())

