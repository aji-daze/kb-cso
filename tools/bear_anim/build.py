# -*- coding: utf-8 -*-
"""しろくまが本を読む GIF / WebP を作る。
元絵は描き直さず、めくれる紙とまぶただけをプログラムで重ねる。"""
from PIL import Image
import math, os, page as P, blink as BL

TURN = 15
MS_TURN = 50
MS_HOLD_A = 900     # まばたきの前
MS_HOLD_B = 520     # まばたきのあと、めくるまで
BLINKS = [0.55, 1.0, 1.0, 0.6]
MS_BLINK = 45
TH0, TH1 = 0.10, 2.30


def frames(size_out, transparent):
    base = Image.open(P.SRC).convert('RGBA')
    W = base.size[0] * P.SS
    art = base.resize((W, W), Image.LANCZOS)
    if transparent:
        stage = art
    else:
        stage = Image.new('RGBA', (W, W), (255, 255, 255, 255))
        stage.alpha_composite(art)
    mask = P.above_mask((W, W), P.SS)
    cols = BL.sample(base)

    out, durs = [stage.copy()], [MS_HOLD_A]
    for c in BLINKS:                       # まばたき
        out.append(BL.apply(stage, c, P.SS, cols)); durs.append(MS_BLINK)
    out.append(stage.copy()); durs.append(MS_HOLD_B)
    for i in range(TURN):                  # ページをめくる
        e = 0.5 - 0.5 * math.cos(math.pi * (i + 0.5) / TURN)
        out.append(P.frame(stage, mask, (W, W), TH0 + (TH1 - TH0) * e, P.SS))
        durs.append(MS_TURN)
    return [f.resize((size_out, size_out), Image.LANCZOS) for f in out], durs


def save_gif(path, size=400, colors=160):
    fr, durs = frames(size, transparent=False)
    rgb = [f.convert('RGB') for f in fr]
    stack = Image.new('RGB', (size, size * len(rgb)))
    for i, f in enumerate(rgb):
        stack.paste(f, (0, i * size))
    pal = stack.quantize(colors=colors, method=Image.MEDIANCUT)
    q = [f.quantize(palette=pal, dither=Image.FLOYDSTEINBERG) for f in rgb]
    q[0].save(path, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True)
    return os.path.getsize(path)


def save_webp(path, size=480, quality=90):
    fr, durs = frames(size, transparent=True)
    fr[0].save(path, save_all=True, append_images=fr[1:], duration=durs,
               loop=0, quality=quality, method=6)
    return os.path.getsize(path)


HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.normpath(os.path.join(HERE, '..', '..', 'docs', 'read', 'art'))

if __name__ == '__main__':
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else ART
    print('webp', save_webp(os.path.join(out, 'bear.webp'), size=480, quality=84))
    print('gif ', save_gif(os.path.join(out, 'bear-reading.gif')))
