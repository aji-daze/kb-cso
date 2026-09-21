# -*- coding: utf-8 -*-
"""しろくまがページをめくるアニメーション。
元絵は描き直さず、めくれる紙だけを上に重ねる。"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import math, os

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bear-source.png')
SS = 2

# --- 元絵から読み取った本の形（原寸の座標） ---------------------------
A   = (412.0, 724.0)   # 折り目の上
B   = (497.0, 945.0)   # 折り目の下
VRA = (236.0, -18.0)   # 右に寝たときの外端（上）
VRB = (186.0, -26.0)   # 右に寝たときの外端（下）
VLA = (-110.0, -62.0)  # 左に寝たときの外端（上）
VLB = (-198.0, -44.0)  # 左に寝たときの外端（下）
UA  = (-76.0, -56.0)     # 立ったときに持ち上がる量（上）
UB  = (-90.0, -72.0)   # 同（下）
BEND = 1.25            # 紙の反り

# 本の上の稜線。これより下は本の中なので紙を出さない。
TOP_EDGE = [(276.0, 628.0), (412.0, 720.0), (656.0, 680.0), (720.0, 692.0)]

PAGE  = (249, 242, 230)
SHADE = (228, 218, 202)
LINE  = (150, 161, 178)
DROP  = (150, 165, 185)


def poly_area(p):
    a = 0.0
    for i in range(len(p)):
        x1, y1 = p[i]; x2, y2 = p[(i + 1) % len(p)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def pt(hinge, VR, VL, U, th, u):
    c = (1 + math.cos(th)) / 2
    s = (1 - math.cos(th)) / 2
    d = (c * VR[0] + s * VL[0] + math.sin(th) * U[0],
         c * VR[1] + s * VL[1] + math.sin(th) * U[1])
    return (hinge[0] + u * d[0], hinge[1] + u * d[1])


def edges(th, n=16):
    bend = BEND * math.sin(th)
    top, bot = [], []
    for i in range(n + 1):
        u = i / n
        t = th + bend * u
        top.append(pt(A, VRA, VLA, UA, t, u))
        bot.append(pt(B, VRB, VLB, UB, t, u))
    return top, bot


def draw_page(size, th, sc):
    top, bot = edges(th)
    S = lambda p: (p[0] * sc, p[1] * sc)
    poly = [S(p) for p in top] + [S(p) for p in reversed(bot)]

    lay = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(lay).polygon(poly, fill=PAGE + (255,))

    # 折り目側を少し暗く（別レイヤで重ねる。直接描くと alpha ごと置き換わる）
    k = 6
    sh = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([S(p) for p in top[:k + 1]] + [S(p) for p in reversed(bot[:k + 1])],
                               fill=SHADE + (120,))
    sh = sh.filter(ImageFilter.GaussianBlur(6 * sc))
    sh.putalpha(ImageChops.multiply(sh.getchannel('A'), lay.getchannel('A')))
    lay.alpha_composite(sh)

    # 輪郭。毛の上に出ても見えるように、やわらかい線を1本。
    # ただし紙が細く見えるコマでは弱める（鼻から棒が出ているように見えるため）。
    k2 = min(1.0, poly_area(poly) / (sc * sc * 5200.0))
    ln = Image.new('RGBA', size, (0, 0, 0, 0))
    d2 = ImageDraw.Draw(ln)
    w = max(1, int(2.4 * sc))
    d2.line([S(p) for p in top], fill=LINE + (int(165 * k2),), width=w, joint='curve')
    d2.line([S(top[-1]), S(bot[-1])], fill=LINE + (int(185 * k2),), width=w)
    d2.line([S(p) for p in bot], fill=LINE + (int(105 * k2),), width=w, joint='curve')
    lay.alpha_composite(ln.filter(ImageFilter.GaussianBlur(0.7 * sc)))

    lay = lay.filter(ImageFilter.GaussianBlur(0.8 * sc))

    # 落ち影
    drop = Image.new('RGBA', size, (0, 0, 0, 0))
    ImageDraw.Draw(drop).polygon([(p[0] + 4 * sc, p[1] + 8 * sc) for p in poly], fill=DROP + (70,))
    drop = drop.filter(ImageFilter.GaussianBlur(5 * sc))
    return drop, lay


def above_mask(size, sc):
    m = Image.new('L', size, 0)
    pts = [(p[0] * sc, p[1] * sc) for p in TOP_EDGE]
    ImageDraw.Draw(m).polygon([(0, 0), (size[0], 0), (size[0], pts[-1][1])]
                              + list(reversed(pts)) + [(0, pts[0][1])], fill=255)
    return m.filter(ImageFilter.GaussianBlur(1.2 * sc))


def frame(flat, mask, size, th, sc):
    fr = flat.copy()
    drop, lay = draw_page(size, th, sc)
    for l in (drop, lay):
        l.putalpha(ImageChops.multiply(l.getchannel('A'), mask))
        fr.alpha_composite(l)
    return fr


def stage():
    base = Image.open(SRC).convert('RGBA')
    W = base.size[0] * SS
    flat = Image.new('RGBA', (W, W), (255, 255, 255, 255))
    flat.alpha_composite(base.resize((W, W), Image.LANCZOS))
    return flat, above_mask((W, W), SS), (W, W)


def ease(p):
    return math.pi * (0.5 - 0.5 * math.cos(math.pi * p))
