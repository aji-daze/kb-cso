# -*- coding: utf-8 -*-
"""まばたき。目の楕円を毛の色で塗りつぶし、まぶたの線を1本引く。"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

# 元絵から測った目の位置（暗い塊の外接から）
EYES = [
    {'c': (481.0, 578.0), 'r': (19.0, 27.5)},   # 左（画面の左）
    {'c': (643.0, 611.0), 'r': (25.5, 29.5)},   # 右
]
LID = (74, 72, 80)      # まぶたの線の色


def fur_color(arr, cx, cy, rx, ry):
    """目のまわりの毛の色。眼鏡（青みがある）と目（暗い）は外して中央値を取る。"""
    h, w = arr.shape[:2]
    x0, x1 = int(cx - rx * 2.4), int(cx + rx * 2.4)
    y0, y1 = int(cy - ry * 2.0), int(cy + ry * 2.0)
    box = arr[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
    ys, xs = np.mgrid[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
    d = ((xs - cx) / (rx + 6)) ** 2 + ((ys - cy) / (ry + 6)) ** 2
    lum = box[..., :3].mean(axis=2)
    blueish = (box[..., 2] - box[..., 0]) > 12
    ok = (d > 1) & (lum > 215) & (~blueish) & (box[..., 3] > 200)
    if ok.sum() < 50:
        return (252, 249, 243)
    return tuple(int(v) for v in np.median(box[ok][:, :3], axis=0))


def lid_path(cx, cy, rx, y, lift):
    """まぶたの線。中央がすこし持ち上がった浅い弧。"""
    pts = []
    n = 14
    for i in range(n + 1):
        t = i / n
        x = cx - rx * 0.96 + 2 * rx * 0.96 * t
        pts.append((x, y - lift * (1 - (2 * t - 1) ** 2)))
    return pts


def apply(img, close, sc=1.0, colors=None):
    """close=0 で開いたまま、1 で閉じる。img は RGBA（sc 倍に拡大済み）。"""
    if close <= 0.001:
        return img
    size = img.size
    lay = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for i, e in enumerate(EYES):
        cx, cy = e['c']; rx, ry = e['r']
        fur = colors[i]
        top, bot = cy - ry - 3, cy + ry + 3
        cover_y = top + close * (bot - top)      # まぶたが隠すところ
        ly = min(cover_y, cy + ry * 0.30)        # 線はこの高さで止まる
        # まぶたが降りたぶんだけ、目を毛の色で隠す
        clip = Image.new('L', size, 0)
        ImageDraw.Draw(clip).ellipse([(cx - rx - 3) * sc, (cy - ry - 3) * sc,
                                      (cx + rx + 3) * sc, (cy + ry + 3) * sc], fill=255)
        ImageDraw.Draw(clip).rectangle([0, cover_y * sc, size[0], size[1]], fill=0)
        cover = Image.new('RGBA', size, fur + (255,))
        cover.putalpha(clip.filter(ImageFilter.GaussianBlur(1.1 * sc)))
        lay.alpha_composite(cover)
        # 線より下に目が残ると、白い隙間の下に黒が覗いて見苦しい。
        # 閉じ切る手前から、残りの目も消していく。
        k = max(0.0, (close - 0.55) / 0.45)
        if k > 0:
            rest = Image.new('L', size, 0)
            ImageDraw.Draw(rest).ellipse([(cx - rx - 3) * sc, (cy - ry - 3) * sc,
                                          (cx + rx + 3) * sc, (cy + ry + 3) * sc],
                                         fill=int(255 * min(1.0, k)))
            full = Image.new('RGBA', size, fur + (255,))
            full.putalpha(rest.filter(ImageFilter.GaussianBlur(1.1 * sc)))
            lay.alpha_composite(full)
        # まぶたの線
        lift = 5.5 * min(1.0, close * 1.6)
        w = max(1, int((3.4 + 2.0 * close) * sc))
        d.line([(x * sc, y * sc) for x, y in lid_path(cx, cy, rx, ly, lift)],
               fill=LID + (int(235 * min(1.0, close * 2.2)),), width=w, joint='curve')
    out = img.copy()
    out.alpha_composite(lay.filter(ImageFilter.GaussianBlur(0.6 * sc)))
    return out


def sample(src_rgba):
    arr = np.array(src_rgba).astype(int)
    return [fur_color(arr, e['c'][0], e['c'][1], e['r'][0], e['r'][1]) for e in EYES]
