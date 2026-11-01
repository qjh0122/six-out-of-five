#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 icons/icon-512.png 派生一张真正的 maskable 图标。

为什么需要单独一张
------------------
`purpose: "any"` 的图标就是「原样贴上去」：系统不做任何裁切，图里画了什么就是什么。
`purpose: "maskable"` 的语义完全相反 —— **系统会拿一个形状去裁它**，
圆形 / 圆角方 / 水滴 / 超椭圆，各家不同，页面无法预知，也无法阻止。

Android 的规则是「安全区 = 以中心为圆心、直径等于图标边长 80% 的圆」，
圆外的东西不保证会被保留。原图是一张**带金色圆角边框**的 512 图：

    金色边框外沿在 26px → 它的角点 (26,26) 到中心 (256,256) 距离 325px
    安全圆半径 = 512 × 0.4 = 205px
    325 > 205  ⇒  四个角一定被切掉

实际效果就是圆形裁切下金边在四角断开，露出底下的深绿，看着像毛边。
（不是「露白」—— 底色是画的深绿，只是边框断了。）

所以 maskable 不能复用 any 那张，必须重画：满幅底色 + 图形整体内缩。
这个脚本只做几何换算和重排，**不重画字形** ——
白卡和红字都是从原图裁出来等比缩放的，品牌保持一致。

用法
----
    python scripts/gen-maskable-icon.py

依赖 Pillow（`pip install Pillow`）。产物写进 pwa/icons/，会被 git 一起提交。
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('需要 Pillow：pip install Pillow')

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, '..', 'pwa', 'icons')
SRC = os.path.join(ICON_DIR, 'icon-512.png')

# 原图里量出来的常量（见 REVIEW 41.1，都是对着像素数出来的，不是估的）
SRC_SIZE = 512
CARD_BOX = (113, 72, 400, 441)        # 白色竖长卡片的包围盒，宽 287 高 369
BG_COLOR = (22, 56, 47)               # #16382F，与 theme_color 同一个色
SAFE_RATIO = 0.4                      # 安全圆半径 = 边长 × 0.4（Android 规范）

# 目标卡片尺寸：要满足「最远点距中心 ≤ 安全半径」
# 卡片是竖长圆角矩形，最远点是四角，距离 = sqrt((w/2-rr)^2 + (h/2-rr)^2) + rr
TARGET_W = 250
TARGET_H = 321
TARGET_RADIUS = 48
SS = 4                                # 超采样倍数，缩回时边缘才干净

OUT_512 = os.path.join(ICON_DIR, 'icon-maskable-512.png')
OUT_192 = os.path.join(ICON_DIR, 'icon-maskable-192.png')


def farthest_point_dist(w, h, r):
    """圆角矩形最远点到中心的距离。用来验证图形确实落在安全圆内。"""
    half_w, half_h = w / 2.0, h / 2.0
    import math
    return math.hypot(half_w - r, half_h - r) + r


def main():
    if not os.path.exists(SRC):
        sys.exit('找不到源图：%s' % SRC)

    safe_r = SRC_SIZE * SAFE_RATIO
    far = farthest_point_dist(TARGET_W, TARGET_H, TARGET_RADIUS)
    if far > safe_r:
        sys.exit('卡片尺寸不合规：最远点 %.1f > 安全半径 %.1f' % (far, safe_r))
    print('卡片最远点 %.1f，安全半径 %.1f，余量 %.1f px' % (far, safe_r, safe_r - far))

    src = Image.open(SRC).convert('RGB')
    card = src.crop(CARD_BOX)

    # 4 倍超采样：先在 2048 画布上按比例画，再整体缩回 512
    big = SRC_SIZE * SS
    canvas = Image.new('RGB', (big, big), BG_COLOR)

    card_big = card.resize((TARGET_W * SS, TARGET_H * SS), Image.LANCZOS)
    mask = Image.new('L', card_big.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, card_big.size[0] - 1, card_big.size[1] - 1],
        radius=TARGET_RADIUS * SS, fill=255)

    canvas.paste(card_big, ((big - card_big.size[0]) // 2,
                            (big - card_big.size[1]) // 2), mask)

    out512 = canvas.resize((512, 512), Image.LANCZOS)
    out512.save(OUT_512, 'PNG', optimize=True)
    out512.resize((192, 192), Image.LANCZOS).save(OUT_192, 'PNG', optimize=True)

    for p in (OUT_512, OUT_192):
        print('写出 %s  (%d 字节)' % (os.path.relpath(p, os.path.join(HERE, '..')),
                                     os.path.getsize(p)))


if __name__ == '__main__':
    main()
