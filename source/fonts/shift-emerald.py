# moves every glyph one font pixel right inside its advance, so a caret before a glyph never covers its first column
# usage: python shift-emerald.py PokemonEmeraldPro.woff2 (needs fonttools + brotli)
import sys
from fontTools.ttLib import TTFont

PIXEL = 64
path = sys.argv[1]
font = TTFont(path)
glyf, hmtx = font['glyf'], font['hmtx']
for name in font.getGlyphOrder():
    glyph = glyf[name]
    if glyph.numberOfContours == 0:
        continue
    if glyph.isComposite():
        for component in glyph.components:
            component.x += PIXEL
    else:
        glyph.coordinates.translate((PIXEL, 0))
    glyph.recalcBounds(glyf)
    advance, lsb = hmtx[name]
    hmtx[name] = (advance, lsb + PIXEL)
font.save(path)
