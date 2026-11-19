# maps the return symbol U+23CE to Galmuri's return arrow U+21B5, which the app's placeholder uses and no bundled font has
# usage: python alias-galmuri.py Galmuri9-Hangul.woff2 (needs fonttools + brotli)
import sys
from fontTools.ttLib import TTFont

ALIASES = {0x23CE: 0x21B5}
path = sys.argv[1]
font = TTFont(path)
for table in font['cmap'].tables:
    if table.isUnicode():
        for alias, source in ALIASES.items():
            if source in table.cmap:
                table.cmap[alias] = table.cmap[source]
font.save(path)
