# gives the keyboard symbols one font pixel of side bearing on each side, so two of them never touch
# usage: python key-bearings.py FONT.woff2 PIXEL_UNITS (64 for Emerald, 100 for Galmuri9, 50 for Departure Mono)
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen

KEYS = [0x2318, 0x21B5, 0x23CE, 0x21E7, 0x2325, 0x2303, 0x238B]
path, pixel = sys.argv[1], int(sys.argv[2])
font = TTFont(path)
hmtx, glyphs = font['hmtx'], font.getGlyphSet()
cff = font['CFF '].cff if 'CFF ' in font else None
done = set()
for code in KEYS:
    name = font.getBestCmap().get(code)
    if not name or name in done:
        continue
    done.add(name)
    pen = BoundsPen(glyphs)
    glyphs[name].draw(pen)
    if not pen.bounds:
        continue
    x_min, _, x_max, _ = pen.bounds
    shift = pixel - x_min
    advance = int(x_max - x_min + 2 * pixel)
    if cff is not None:
        top = cff[cff.fontNames[0]]
        pen = T2CharStringPen(advance, glyphs)
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, 1, shift, 0)))
        charstring = pen.getCharString(private=top.Private, globalSubrs=top.GlobalSubrs)
        top.CharStrings[name] = charstring
    else:
        glyf = font['glyf']
        glyph = glyf[name]
        if glyph.isComposite():
            for component in glyph.components:
                component.x += shift
        else:
            glyph.coordinates.translate((shift, 0))
        glyph.recalcBounds(glyf)
    hmtx[name] = (int(x_max - x_min + 2 * pixel), pixel)
    print(f'{code:04X} {name}: ink {(x_max - x_min) / pixel:g} px, advance {(x_max - x_min) / pixel + 2:g} px')
font.save(path)
