"""Reproduce the approved Solid logo geometry and outlined Manrope lettering.

Design tooling only. Requires fontTools; no application dependencies.
"""
from pathlib import Path
from itertools import count
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'source'
PALETTE = {'light': ('#2449D8', '#101828', '#475467'),
           'dark': ('#6C8CFF', '#F2F4F7', '#98A2B3'),
           'black': ('#000000', '#000000', '#000000'),
           'white': ('#FFFFFF', '#FFFFFF', '#FFFFFF')}
L_PATH = 'M6 0H18Q24 0 24 6V40.5H55Q61 40.5 61 46.5V64H6Q0 64 0 58V6Q0 0 6 0Z'
MASK_IDS = count()


def face(weight):
    font = instantiateVariableFont(TTFont(SOURCE / 'Manrope-variable.ttf'), {'wght': weight})
    return font, font.getGlyphSet(), font.getBestCmap()


DISPLAY = face(800)
SMALL = face(600)


def lettering(text, size, x, baseline, color, weight='display', tracking=0):
    font, glyphs, cmap = DISPLAY if weight == 'display' else SMALL
    scale = size / font['head'].unitsPerEm
    cursor = x
    paths = []
    for ch in text:
        glyph = glyphs[cmap[ord(ch)]]
        pen = SVGPathPen(glyphs)
        glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, baseline)))
        paths.append(f'<path d="{pen.getCommands()}"/>')
        cursor += glyph.width * scale + tracking
    return f'<g fill="{color}">' + ''.join(paths) + '</g>', cursor - x - tracking


def svg(width, height, body, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" role="img" aria-label="{label}">'
            f'<title>{label}</title>{body}</svg>')


def symbol(color, x=0, y=0, height=64):
    vertical, _ = lettering('AEO', 14.25, 0, 0, '#000000', tracking=0.45)
    horizontal, width = lettering('GEO', 14.25, 0, 57.6, '#000000', tracking=0.45)
    mask_id = f'lettering-{next(MASK_IDS)}'
    holes = f'<g transform="translate(17.2 37.25) rotate(-90)">{vertical}</g>'
    holes += f'<g transform="translate({42-width/2} 0)">{horizontal}</g>'
    body = (f'<defs><mask id="{mask_id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            f'<rect width="64" height="64" fill="#FFFFFF"/>{holes}</mask></defs>'
            f'<path fill="{color}" mask="url(#{mask_id})" d="{L_PATH}"/>')
    return f'<g transform="translate({x} {y}) scale({height/64})">{body}</g>'


def lockup(theme):
    accent, text, secondary = PALETTE[theme]
    word, wordwidth = lettering('LyraSEO AI', 88, 88, 78, text, tracking=-1.2)
    width = round(88 + wordwidth + 8)
    height = 104
    body = symbol(accent, 8, 8, 70) + word
    return width, height, body


def write_assets():
    for theme in PALETTE:
        for suffix in ['', '-aeo-geo']:
            width, height, body = lockup(theme)
            name = f'lyraseo-{theme}{suffix}'
            (ROOT / f'{name}.svg').write_text(svg(width, height, body,
                'LyraSEO AI — AEO and GEO'))
        (ROOT / f'lyraseo-symbol-{theme}.svg').write_text(svg(64, 64,
            symbol(PALETTE[theme][0], 1.5, 0), 'LyraSEO AI — AEO and GEO'))
    tile = '<rect width="64" height="64" rx="14" fill="#2449D8"/>' + symbol('#FFFFFF', 11, 10, 44)
    (ROOT / 'lyraseo-favicon.svg').write_text(svg(64, 64, tile, 'LyraSEO AI'))

    # The board uses the same outlined paths as the vector masters.
    parts = ['<rect width="1440" height="1000" fill="#F5F7FC"/>']
    def label(text, size, x, y, color='#101828'):
        parts.append(lettering(text, size, x, y, color, 'small')[0])
    label('LyraSEO AI / Solid', 36, 64, 76)
    label('Balanced AEO and GEO lettering in every L symbol', 18, 64, 112, '#475467')
    parts.append('<rect x="48" y="152" width="664" height="340" rx="12" fill="#FFFFFF"/>')
    parts.append('<rect x="728" y="152" width="664" height="340" rx="12" fill="#0B1220"/>')
    label('Light surface', 18, 80, 195, '#475467')
    label('Dark surface', 18, 760, 195, '#98A2B3')
    for theme, x in [('light', 106), ('dark', 786)]:
        logo_width, _, body = lockup(theme)
        scale = min(1.18, 548 / logo_width)
        parts.append(f'<g transform="translate({x} 270) scale({scale})">{body}</g>')
    label('Compact lockup', 18, 64, 548, '#475467')
    logo_width, _, body = lockup('light')
    scale = min(1, 548 / logo_width)
    parts.append(f'<g transform="translate(64 586) scale({scale})">{body}</g>')
    label('Compact symbol', 18, 676, 548, '#475467')
    parts.append(f'<g transform="translate(676 586) scale(1.4)">{tile}</g>')
    label('Symbol detail', 18, 1000, 548, '#475467')
    parts.append(symbol('#2449D8', 1000, 572, 120))
    parts.append('<path d="M64 740H1376" stroke="#D0D5DD"/>')
    label('Small-size exports', 18, 64, 790, '#475467')
    for x, size in [(64,16),(160,24),(264,32),(376,48)]:
        parts.append(f'<g transform="translate({x} 822) scale({size/64})">{tile}</g>')
        label(str(size)+' px', 14, x, 902, '#475467')
    label('Manrope 800 / 600', 18, 676, 790, '#475467')
    label('Cobalt / Graphite / White', 18, 676, 830, '#475467')
    label('AEO and GEO included in every symbol and icon size.', 18, 676, 902, '#475467')
    label('Design assets only / Application build remains pending', 14, 64, 960, '#475467')
    (ROOT / 'logo-preview.svg').write_text(svg(1440, 1000, ''.join(parts), 'LyraSEO AI Solid logo with AEO and GEO inside the L'))


if __name__ == '__main__':
    write_assets()
    print('Wrote integrated-L logos and icons; no plain-symbol variant.')
