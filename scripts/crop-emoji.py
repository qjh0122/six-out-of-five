"""从参考截图裁出 13 个表情 —— 软 alpha 版（替换旧的二值抠底）

旧脚本（v1）的四个毛病，正是「边上出现坏边」的来源：

  1. **alpha 只有 0 / 255**。球体边上是抗锯齿过渡带，被硬切成非黑即白之后，
     边缘就是一圈台阶；缩到 40~60 CSS px 时台阶变成毛刺。
  2. **没有去底色污染**。过渡带像素 = 球体色 × 覆盖率 + 浅紫背景 × (1−覆盖率)，
     直接当不透明存下来，深色毡面上就是一圈浅紫/灰白光晕。
  3. **逐格按包围盒拉满 96×96**。每个表情的缩放系数都不同 ——
     带披风的恶魔被缩小、圆脸被放大，13 个摆在一起大小不齐；
     4px 边距对「耳朵 / 帽子 / 泪滴」这类外挂部件也太紧，会被切掉一截。
  4. **把源图自带的软投影一起抠了进来**。每个球下面都有一片灰色投影，
     在浅紫底上看不出来，抠到深色毡面上就是一团灰雾。

v2 的做法：

  · 整张图 ×4 超采样（LANCZOS）后再算 alpha —— 边缘天然是渐变，没有台阶；
  · alpha = 与背景色差的软阈值（5→22），再 0.35px 高斯把残余噪声压掉；
  · **投影像素单独判掉**：投影是「背景色的等比压暗」（饱和度与背景几乎相同），
    球体是「饱和的绿/红」或「很暗的黑」。判据用「饱和度接近背景 + 亮度 > 0.45×背景」，
    再从画布四边泛洪，只吃掉与外界连通的部分 —— 嘴里的白牙、眼里高光虽然也接近
    中性色，但被高饱和的球面包着，泛洪到不了，不会被误抠成洞；
  · 反解颜色（去底色污染）：F = (P − (1−a)·B) / a，B 取**最近的那个背景像素**
    （球下方最近的背景其实是投影灰，用它反解才不会在球底留一圈紫边）；
  · 13 个表情共用**同一套**缩放系数（共同画框 BOX），相对大小保持原样；
  · 透明化与缩放全程在**预乘 alpha** 空间做，缩小时不会把透明像素的黑色渗进边缘；
  · 每个格子收「质心落在本格内」的**所有**前景连通块 —— 泪滴、帽子这类
    与脸不连的部件也算进来，不会被切掉。

用法：
  python scripts/crop-emoji.py <源图> [输出目录]
产物：e0-dizzy.png … e12-grit.png（96×96，RGBA，无底色污染）
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

SRC = sys.argv[1] if len(sys.argv) > 1 else None
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'pwa', 'assets', 'emoji')

SS = 4                      # 超采样倍数
OUT_SIZE = 96               # 输出边长（界面里按 40~60 CSS px 用，2 倍屏够）
BOX = 80                    # 共同画框边长（源图像素）：内容约 66，四周留 7~8 的呼吸位
ALPHA_LO = 6.0              # 与背景色差低于此视为「完全透明」（噪声底）
FEATHER_PX = 0.30           # 收尾羽化（源图像素）：压掉解算噪声，边缘不留台阶
MIN_AREA = 60               # 面积小于此（源图像素）的连通块当噪点丢掉
CLUSTER_TOL = 40            # 行/列中心聚类的容差（源图像素）
SAT_TOL = 12                # 饱和度与背景相差在这个范围内 = 中性（投影/背景候选）
SHADOW_LUMA_RATIO = 0.45    # 亮度低于 0.45×背景 = 真·黑（披风等），不当投影

# 参考截图的阅读顺序（3 列 × 5 行，最后一行只有 1 个）
COLS, ROWS = 3, 5
NAMES = ['e0-dizzy', 'e1-devil', 'e2-money',
         'e3-confused', 'e4-love', 'e5-cry',
         'e6-grin', 'e7-angry', 'e8-smug',
         'e9-sweat', 'e10-rage', 'e11-shock',
         'e12-grit']


def cluster(vals, tol=CLUSTER_TOL):
    """一维聚类：把相邻差值小于 tol 的合并，返回各簇均值（升序）。"""
    vals = sorted(vals)
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def main():
    if not SRC:
        sys.exit('用法: python scripts/crop-emoji.py <源图> [输出目录]')
    img = Image.open(SRC).convert('RGB')
    W, H = img.size
    print('源图 %dx%d' % (W, H))

    # ---- 背景色：四边一圈像素的中位数（不用单点：截图四角可能带圆角/阴影）----
    a0 = np.asarray(img).astype(np.float32)
    frame = np.concatenate([
        a0[0:3, :].reshape(-1, 3), a0[-3:, :].reshape(-1, 3),
        a0[:, 0:3].reshape(-1, 3), a0[:, -3:].reshape(-1, 3)])
    bg = np.median(frame, axis=0)
    print('背景色 RGB(%.0f, %.0f, %.0f)' % tuple(bg))

    # ---- 超采样后在高分辨率上算 alpha ----
    big = img.resize((W * SS, H * SS), Image.LANCZOS)
    a = np.asarray(big).astype(np.float32)
    d = np.sqrt(((a - bg) ** 2).sum(axis=2))

    # ---- 把源图自带的软投影判成背景 ----
    # 投影 = 背景色的等比压暗：饱和度几乎不变（33 → 25~33），只是亮度往下走。
    # 球体要么是高饱和的绿/红（饱和度 60~90），要么是极暗的黑（亮度 < 0.45×背景）。
    # 所以「饱和度贴着背景 + 亮度还行」= 投影或背景。
    # 再从画布四边泛洪，只吃与外界连通的那片：嘴里的白牙、眼里的高光饱和度也低，
    # 但被高饱和的球面包着，泛洪到不了，不会被误抠成洞。
    sat = a.max(axis=2) - a.min(axis=2)
    luma = a.mean(axis=2)
    bg_sat = float(bg.max() - bg.min())
    bg_luma = float(bg.mean())
    bgish = (np.abs(sat - bg_sat) <= SAT_TOL) & (luma >= bg_luma * SHADOW_LUMA_RATIO)
    seed = np.zeros_like(bgish)
    seed[0, :] = bgish[0, :]; seed[-1, :] = bgish[-1, :]
    seed[:, 0] = bgish[:, 0]; seed[:, -1] = bgish[:, -1]
    outside = ndi.binary_propagation(seed, mask=bgish)
    print('投影/背景占 %.1f%%' % (outside.mean() * 100))

    # ---- alpha：边界 2px 用「已知底色 + 已知纯色」的投影解算，内部直接 1 ----
    # 为什么不能只按色差归一：50% 覆盖的像素与背景色差已经是满色的 6 成，
    # 拿色差直接除会让边缘「虚胖」（alpha 早早到 1），残留的背景色就变成了紫边。
    # 正确做法是把 P 投影到 (F−B) 这条线上：a = ⟨P−B, F−B⟩ / |F−B|²。
    #   B：最近的那个背景像素（球底附近最近的是投影灰，不是浅紫）
    #   F：向内缩 2px 之后的纯色（那里必然是不透明的球体本身）
    idx = ndi.distance_transform_edt(outside, return_distances=False, return_indices=True)
    bgmap = a[tuple(idx)]

    shape = (~outside) & (d > ALPHA_LO)
    core = ndi.binary_erosion(shape, iterations=SS * 2)
    if not core.any():
        core = shape
    inner_idx = ndi.distance_transform_edt(~core, return_distances=False, return_indices=True)
    fpure = a[tuple(inner_idx)]

    vb = fpure - bgmap
    denom = (vb ** 2).sum(axis=2)
    alpha = np.where(denom > 400,
                     ((a - bgmap) * vb).sum(axis=2) / np.maximum(denom, 1.0),
                     0.0)
    alpha = np.clip(alpha, 0.0, 1.0)
    alpha = np.where(core, 1.0, alpha)
    alpha = np.where(outside, 0.0, alpha)
    # 收尾羽化：把解算的噪声压掉（0.3 源图像素），边缘是连续渐变而不是台阶
    alpha = np.asarray(
        Image.fromarray((alpha * 255).astype(np.uint8))
        .filter(ImageFilter.GaussianBlur(SS * FEATHER_PX))
    ).astype(np.float32) / 255.0

    # ---- 去底色污染（反预乘）----
    al = np.maximum(alpha, 0.06)[..., None]
    fg = (a - (1.0 - al) * bgmap) / al
    fg = np.clip(fg, 0, 255)
    fg = np.where((alpha < 0.02)[..., None], fg.mean(axis=(0, 1)), fg)   # 全透明处颜色无意义

    # ---- 连通块：每个表情的全部部件（脸 / 泪滴 / 帽子 / 披风）----
    solid = alpha > 0.5
    hh, ww = solid.shape
    labels = np.zeros(solid.shape, dtype=np.int32)
    boxes = []
    cur = 0
    min_area = MIN_AREA * SS * SS
    for sy in range(hh):
        row = solid[sy]
        for sx in range(ww):
            if not row[sx] or labels[sy, sx]:
                continue
            cur += 1
            q = deque([(sx, sy)])
            labels[sy, sx] = cur
            x0 = x1 = sx
            y0 = y1 = sy
            area = 0
            while q:
                x, y = q.popleft()
                area += 1
                if x < x0: x0 = x
                elif x > x1: x1 = x
                if y < y0: y0 = y
                elif y > y1: y1 = y
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < ww and 0 <= ny < hh and solid[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = cur
                        q.append((nx, ny))
            if area >= min_area:
                boxes.append({'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
                              'cx': (x0 + x1) / 2.0, 'cy': (y0 + y1) / 2.0, 'area': area})
    print('前景连通块 %d 个 / 保留 %d 个' % (cur, len(boxes)))
    if not boxes:
        sys.exit('没有找到前景，检查源图或阈值')

    # ---- 行列中心聚类，再按「质心落在哪一格」把部件分给表情 ----
    cxs = cluster([b['cx'] / SS for b in boxes])
    cys = cluster([b['cy'] / SS for b in boxes])
    print('列中心 %s' % [round(v, 1) for v in cxs])
    print('行中心 %s' % [round(v, 1) for v in cys])
    if len(cxs) != COLS or len(cys) != ROWS:
        sys.exit('行列数与预期不符（%d 列 / %d 行）：源图排布变了，先改 COLS/ROWS'
                 % (len(cxs), len(cys)))

    xb = [0] + [(cxs[i] + cxs[i + 1]) / 2.0 * SS for i in range(len(cxs) - 1)] + [ww]
    yb = [0] + [(cys[i] + cys[i + 1]) / 2.0 * SS for i in range(len(cys) - 1)] + [hh]

    def cell_of(cx, cy):
        ci = max(i for i in range(len(cxs)) if cx >= xb[i])
        ri = max(i for i in range(len(cys)) if cy >= yb[i])
        return ri, ci

    cells = {}
    for b in boxes:
        key = cell_of(b['cx'], b['cy'])
        c = cells.get(key)
        if not c:
            cells[key] = dict(b)
        else:
            c['x0'] = min(c['x0'], b['x0']); c['x1'] = max(c['x1'], b['x1'])
            c['y0'] = min(c['y0'], b['y0']); c['y1'] = max(c['y1'], b['y1'])
            c['cx'] = (c['x0'] + c['x1']) / 2.0
            c['cy'] = (c['y0'] + c['y1']) / 2.0

    # ---- 共同画框：所有表情同一缩放，相对大小保持原样；同时确认装得下 ----
    half = BOX * SS / 2.0
    maxreach = 0
    for c in cells.values():
        reach = max(c['cx'] - c['x0'], c['x1'] - c['cx'], c['cy'] - c['y0'], c['y1'] - c['cy'])
        maxreach = max(maxreach, reach)
    print('最大半宽 %.1f / 共同画框半宽 %.1f' % (maxreach / SS, BOX / 2))
    if maxreach > half:
        sys.exit('共同画框装不下（%.1f > %.1f），把 BOX 调大' % (maxreach, half))

    os.makedirs(OUT, exist_ok=True)
    order = 0
    for r in range(ROWS):
        for ci in range(COLS):
            c = cells.get((r, ci))
            if not c:
                continue                      # 最后一行空位，不占名字
            if order >= len(NAMES):
                continue
            name = NAMES[order]
            order += 1
            x0 = int(round(c['cx'] - half)); y0 = int(round(c['cy'] - half))
            x1 = x0 + int(BOX * SS); y1 = y0 + int(BOX * SS)
            A = alpha[y0:y1, x0:x1]
            F = fg[y0:y1, x0:x1]
            if A.shape[0] != y1 - y0 or A.shape[1] != x1 - x0:
                pw = (max(0, -x0), max(0, -y0), max(0, x1 - ww), max(0, y1 - hh))
                A = np.pad(A, ((pw[1], pw[3]), (pw[0], pw[2])), mode='constant')
                F = np.pad(F, ((pw[1], pw[3]), (pw[0], pw[2]), (0, 0)), mode='constant')
            # 预乘 → 缩小 → 反预乘
            pm = np.dstack([F * A[..., None], A * 255.0])
            small = np.asarray(
                Image.fromarray(np.clip(pm, 0, 255).astype(np.uint8), 'RGBA')
                .resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)).astype(np.float32)
            sa = small[..., 3] / 255.0
            rgb = np.clip(small[..., :3] / np.maximum(sa[..., None], 1e-3), 0, 255)
            out = np.dstack([rgb, sa * 255.0]).astype(np.uint8)
            path = os.path.join(OUT, name + '.png')
            Image.fromarray(out, 'RGBA').save(path, optimize=True)
            cover = float((sa > 0.04).mean()) * 100
            print('  %-12s 包围盒 %2dx%-2d  占画框 %4.1f%%  边缘半透明 %4.1f%%  %s'
                  % (name, round((c['x1'] - c['x0']) / SS), round((c['y1'] - c['y0']) / SS),
                     cover,
                     float(((sa > 0.02) & (sa < 0.98)).mean()) * 100,
                     os.path.basename(path)))
    print('完成 %d / %d 个' % (order, len(NAMES)))
    if order != len(NAMES):
        sys.exit('只裁出 %d 个，少于预期 %d 个' % (order, len(NAMES)))


if __name__ == '__main__':
    main()
