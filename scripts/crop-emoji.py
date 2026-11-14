"""从参考表情包切出 13 个表情 —— v3：网格投影分带 + 逐格定框 + 距离 alpha

═══ 为什么有 v3（2026-11-14 用户报「表情包存在元素缺失」）═══

v2 的三处结构性错误，导致「丢部件 / 削边 / 问号变白雾」：

  1. **按连通块质心把部件分给表情**。疑惑的蓝色问号、大哭的泪滴、得意的紫帽、
     睡觉的 Zzz 都是**脱离球体**的独立连通块，质心稍偏就归到隔壁格 ——
     归错之后既不在自己的窗口里，也不在被归入那格的窗口里，两头都不渲染。
  2. **共同画框 BOX=80 对「内容 74px + 外挂部件」太紧**。球体几乎贴边，
     再叠 0.3px 羽化与 LANCZOS 缩放，最外一圈被削掉：龇牙的头顶、咬牙的上下、
     蝙蝠面具两侧的尖角都是这么没的。
  3. **反解颜色时 F 取「最近的 core 像素」**。对脱离球体的部件，最近的 core
     是绿球本身 —— 解算式 a = ⟨P−B, F−B⟩ / |F−B|² 里 F 完全不是那个部件的颜色，
     蓝色问号解出来 alpha≈0，只剩一层白雾。

v3 的做法（每一处对应上面一条）：

  · 列/行用**投影**分带，不依赖连通块；每一格的内容包围盒只统计
    「最近格心就是本格」的前景像素 —— 不存在「部件被分到别人家」；
  · 13 格共用一个边长 W = max(各格包围盒) + 2×PAD 的窗口，逐格按**自己包围盒
    中心**开窗。窗口必然大于内容，边缘不会贴边被削；共用 W 保证 13 个大小一致；
  · alpha 直接按「与底色的距离」线性映射（LO→HI 两档），对绿球 / 蓝问号 /
    红恶魔 / 黑面具一视同仁，不做逐像素反解；
  · 去底色污染仍做，但底色用**常量**（源图底色均匀），不再取最近像素；
  · 源图自带的投影按「饱和度贴近底色 + 比底色暗」判掉，且只吃与窗口四边连通的那片
    —— 白牙、眼里高光饱和度也低，但被球面包着，泛洪到不了。

v3.1 补的一条（2026-11-14 用户报「得意和生气的眼睛位置再检查一下」）：

  · **内部一律实心**。距离 alpha 只对外轮廓有效；物体内部的浅色像素（眼白、
    眼眶高光、花痴红心外沿）按「离底色多远」会被算成 0.6~0.9 的 alpha，
    再经反解推成纯白，贴到深绿牌桌上就是「眼睛发白、发飘」，看着像位置错了。
    实测虹膜/眼白重心相对球心只差 0.2~0.6px，**是 alpha 不是坐标**。
    做法：离轮廓 1.5 源像素外的内部像素强制 alpha=1，过渡带取 max 保单调。

用法：
  python scripts/crop-emoji.py <源图> [输出目录]
产物：e0-dizzy.png … e12-grit.png（96×96，RGBA，无底色污染）
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

SRC = sys.argv[1] if len(sys.argv) > 1 else None
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'pwa', 'assets', 'emoji')

SS = 4                      # 超采样倍数
OUT_SIZE = 96               # 输出边长（界面里按 40~60 CSS px 用，2 倍屏够）
PAD = 6                     # 窗口在内容外留的边（源图像素）—— 5 起步，别贴着切
ALPHA_LO = 8.0              # 与底色距离小于此 = 全透明
ALPHA_HI = 34.0             # 大于此 = 全不透明（中间线性过渡）
FEATHER_PX = 0.30           # 收尾羽化（源图像素）
INNER_PX = 1.5              # 离轮廓这么远的内部像素强制 alpha=1（源图像素）
STRONG = 30                 # 统计包围盒用的「肯定是前景」阈值
SAT_TOL = 12                # 与底色的饱和度差在此内 = 中性（投影候选）
SHADOW_FLOOR = 0.55         # 亮度低于这个比例就不当投影（真·深色部件）

COLS, ROWS = 3, 5
NAMES = ['e0-dizzy', 'e1-devil', 'e2-money',
         'e3-confused', 'e4-love', 'e5-cry',
         'e6-grin', 'e7-angry', 'e8-smug',
         'e9-sweat', 'e10-rage', 'e11-shock',
         'e12-grit']


def bands(profile, min_gap=3):
    """一维投影 → 内容带 [(start, end), ...]，中间空档至少 min_gap 像素。"""
    on = profile > 0
    out, start = [], None
    gap = 0
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                out.append((start, i - gap))
                start = None
                gap = 0
    if start is not None:
        out.append((start, len(on) - 1))
    return out


def main():
    if not SRC:
        sys.exit('用法: python scripts/crop-emoji.py <源图> [输出目录]')
    img = Image.open(SRC).convert('RGB')
    W0, H0 = img.size
    print('源图 %dx%d' % (W0, H0))

    # ---- 底色：四边一圈像素的中位数 ----
    a0 = np.asarray(img).astype(np.float32)
    frame = np.concatenate([
        a0[0:3, :].reshape(-1, 3), a0[-3:, :].reshape(-1, 3),
        a0[:, 0:3].reshape(-1, 3), a0[:, -3:].reshape(-1, 3)])
    bg = np.median(frame, axis=0)
    print('底色 RGB(%.0f, %.0f, %.0f)' % tuple(bg))

    # ---- 超采样 ----
    big = img.resize((W0 * SS, H0 * SS), Image.LANCZOS)
    a = np.asarray(big).astype(np.float32)
    H, W = a.shape[:2]
    d = np.sqrt(((a - bg) ** 2).sum(axis=2))

    # ---- 分带：用「强前景」投影，避免投影/噪声把相邻两格连成一片 ----
    strong = d > STRONG
    cb = bands(strong.sum(axis=0), min_gap=SS * 3)
    rb = bands(strong.sum(axis=1), min_gap=SS * 3)
    print('内容列带 %s' % [(round(s / SS, 1), round(e / SS, 1)) for s, e in cb])
    print('内容行带 %s' % [(round(s / SS, 1), round(e / SS, 1)) for s, e in rb])
    if len(cb) != COLS or len(rb) != ROWS:
        sys.exit('列/行带数与预期不符（%d 列 / %d 行）：源图排布变了，先改 COLS/ROWS'
                 % (len(cb), len(rb)))

    cc = [(s + e) / 2.0 for s, e in cb]     # 列心
    rc = [(s + e) / 2.0 for s, e in rb]     # 行心

    # ---- 每个前景像素归给「最近的格心」（等比 x / y 分别取最近）----
    xi = np.abs(np.arange(W)[:, None] - np.array(cc)[None, :]).argmin(axis=1)
    yi = np.abs(np.arange(H)[:, None] - np.array(rc)[None, :]).argmin(axis=1)

    cells = {}
    for r in range(ROWS):
        for c in range(COLS):
            m = strong & (yi[:, None] == r) & (xi[None, :] == c)
            ys, xs = np.nonzero(m)
            if len(ys) < 50:
                continue
            cells[(r, c)] = dict(x0=xs.min(), x1=xs.max(), y0=ys.min(), y1=ys.max())
    if len(cells) != len(NAMES):
        sys.exit('只找到 %d 格内容，预期 %d 格' % (len(cells), len(NAMES)))

    # ---- 共用窗口边长：装得下最大的那一格，且留足边距 ----
    need = 0
    for c in cells.values():
        need = max(need, c['x1'] - c['x0'] + 1, c['y1'] - c['y0'] + 1)
    WIN = int(need + PAD * 2 * SS)
    print('最大内容 %d px → 共用窗口 %d px（源图像素）' % (need / SS, WIN / SS))

    # ---- alpha：距离映射（不做逐像素反解，理由见文件头第 3 条）----
    alpha = np.clip((d - ALPHA_LO) / (ALPHA_HI - ALPHA_LO), 0.0, 1.0)

    # ---- 去掉源图自带的投影 ----
    # 判据不是「亮度」，而是「是不是底色的等比压暗」：
    # 实测球下方的投影 RGB(123,129,148)，三通道除以底色 (217,228,250) 得
    # (0.567, 0.566, 0.592) —— 三个比值几乎相等（极差 0.026），也就是 P ≈ k·B。
    # 球体本身是绿的不满足（比如 (207,237,192) 的比值极差 0.27）。
    #
    # 为什么不能用亮度阈值（v3 前两版都栽在这）：投影的 d 高达 130~240，比球体边缘
    # 还「显眼」，而它的亮度从 0.97 一路暗到 0.55 倍底色 —— 任何单一亮度阈值都会
    # 切在投影中间，留下一圈深灰月牙（用户看到的「球底下挂个灰台子」）。
    # 比值判据对它整段成立，一个不剩。
    #
    # 0.40 的下限给真·深色部件留着：蝙蝠面具、恶魔角的比值在 0.18 上下，不是投影。
    # 上限 1.05 排除比底色更亮的（白牙比值 >1）。
    # 再叠一层「与四边连通」：被球面包住的中性区域（白牙、高光）泛洪到不了。
    ratio = a / bg
    spread = ratio.max(axis=2) - ratio.min(axis=2)
    mean_r = ratio.mean(axis=2)
    tint = (spread < 0.06) & (mean_r > 0.40) & (mean_r < 1.05)
    seed = np.zeros_like(tint)
    seed[0, :] = tint[0, :]; seed[-1, :] = tint[-1, :]
    seed[:, 0] = tint[:, 0]; seed[:, -1] = tint[:, -1]
    outside = ndi.binary_propagation(seed, mask=tint)
    alpha = np.where(outside, 0.0, alpha)
    print('底色+投影被判掉 %.1f%%' % (outside.mean() * 100))

    # ---- 内部一律实心：距离 alpha 只对外轮廓有效 ----
    # 「离底色多远」在轮廓边缘是抗锯齿的正确答案，但在**物体内部**的浅色区域
    # （眼白、眼眶高光、花痴红心外沿、龇牙白牙）会算出 0.6~0.9 的 alpha ——
    # 这些像素明明完全不透明。后果有两层，第二层才是用户看到的：
    #   1. 半透明 + 反解 F=(P−(1−a)B)/a 把浅色推成纯白（眼睛「发亮」）；
    #   2. 半透明白色贴到深绿牌桌上会透出底色，边缘再被反解提亮一圈，
    #      整只眼睛看起来「发白、发飘、位置不对」——用户 2026-11-14 报的
    #      「得意和生气的眼睛位置再检查一下」，量下来虹膜/眼白重心偏差只有
    #      1.5px，是 alpha 而不是坐标的问题。
    # 用「到非前景的距离」当实心权重：离轮廓 1.5 源像素以内保留软过渡，
    # 往内拉满到 1。取 max 保证单调，不会在过渡带做出台阶。
    fgmask = (d > ALPHA_LO) & ~outside
    depth = ndi.distance_transform_edt(fgmask)
    alpha = np.maximum(alpha, np.clip(depth / (INNER_PX * SS), 0.0, 1.0))
    alpha = np.where(outside, 0.0, alpha)
    print('内部实心化：alpha=1 占比 %.1f%%' % float((alpha > 0.99).mean() * 100))

    # ---- 收尾羽化 ----
    alpha = np.asarray(
        Image.fromarray((alpha * 255).astype(np.uint8))
        .filter(ImageFilter.GaussianBlur(SS * FEATHER_PX))
    ).astype(np.float32) / 255.0

    # ---- 去底色污染：F = (P − (1−a)·B) / a，B 用常量底色 ----
    al = np.maximum(alpha, 0.06)[..., None]
    fg = np.clip((a - (1.0 - al) * bg) / al, 0, 255)

    # ---- 全透明处的颜色要「渗出」成最近的实心颜色，不能留黑 ----
    # 反解式在 alpha→0 时分母趋零，算出来基本是黑（实测 rgba [0,0,0,14]）。
    # 黑 + 透明本身看不出来，但**任何不做预乘的缩放**（老浏览器、某些截图工具、
    # 我们自己的对比脚本）都会把这圈黑混进边缘，深色底上就是一环黑边。
    # 用最近邻把实心色铺满透明区，边缘再怎么插值都是同色，不会脏。
    solid = alpha > 0.35
    if solid.any():
        near = ndi.distance_transform_edt(~solid, return_distances=False, return_indices=True)
        fg = fg[tuple(near)]

    os.makedirs(OUT, exist_ok=True)
    order = 0
    for r in range(ROWS):
        for c in range(COLS):
            cell = cells.get((r, c))
            if not cell:
                continue
            if order >= len(NAMES):
                continue
            name = NAMES[order]
            order += 1

            cx = (cell['x0'] + cell['x1']) / 2.0
            cy = (cell['y0'] + cell['y1']) / 2.0
            x0 = int(round(cx - WIN / 2.0)); y0 = int(round(cy - WIN / 2.0))
            x1 = x0 + WIN; y1 = y0 + WIN

            A = alpha[y0:y1, x0:x1]
            F = fg[y0:y1, x0:x1]
            if A.shape[0] != WIN or A.shape[1] != WIN:      # 出图边 → 补底色
                pl = max(0, -x0); pt = max(0, -y0)
                pr = max(0, x1 - W); pb = max(0, y1 - H)
                A = np.pad(A, ((pt, pb), (pl, pr)), mode='constant')
                F = np.pad(F, ((pt, pb), (pl, pr), (0, 0)),
                           mode='constant', constant_values=bg[None, None, :])

            # 预乘 → 缩小 → 反预乘（缩小时不让透明像素的黑渗进边缘）
            pm = np.dstack([F * A[..., None], A * 255.0])
            small = np.asarray(
                Image.fromarray(np.clip(pm, 0, 255).astype(np.uint8), 'RGBA')
                .resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)).astype(np.float32)
            sa = small[..., 3] / 255.0
            rgb = np.clip(small[..., :3] / np.maximum(sa[..., None], 1e-3), 0, 255)
            out = np.dstack([rgb, sa * 255.0]).astype(np.uint8)
            path = os.path.join(OUT, name + '.png')
            Image.fromarray(out, 'RGBA').save(path, optimize=True)

            # 边界自检：内容必须离窗口边至少 1.5 源图像素，否则就是「快被切了」
            margin = min(cell['x0'] - x0, cell['y0'] - y0,
                         x1 - 1 - cell['x1'], y1 - 1 - cell['y1']) / SS
            flag = '  <<< 贴边' if margin < 1.5 else ''
            print('  %-12s 内容 %2dx%-2d  留白 %4.1f px  占画框 %4.1f%%%s'
                  % (name, round((cell['x1'] - cell['x0'] + 1) / SS),
                     round((cell['y1'] - cell['y0'] + 1) / SS), margin,
                     float((sa > 0.04).mean()) * 100, flag))

    print('完成 %d / %d 个' % (order, len(NAMES)))
    if order != len(NAMES):
        sys.exit('只裁出 %d 个，少于预期 %d 个' % (order, len(NAMES)))


if __name__ == '__main__':
    main()
