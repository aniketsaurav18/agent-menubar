"""Generate tray/app icons + small menu item icons."""
import math
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SS = 8  # supersample factor


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad_img(size, c1, c2, horizontal=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(size):
        c = lerp(c1, c2, i / max(size - 1, 1))
        if horizontal:
            d.line([(i, 0), (i, size)], fill=c)
        else:
            d.line([(0, i), (size, i)], fill=c)
    return img


def robot_glyph_mask(big: int, pad: float):
    """Robot-head glyph (antenna + rounded head + face cutouts) as an L mask."""
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    s = (big - 2 * pad) / 24

    def X(x):
        return pad + x * s

    def Y(y):
        return pad + y * s

    # antenna ball + stem
    br = 1.7 * s
    bx, by = X(12), Y(2.5)
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=255)
    d.rounded_rectangle([X(11.25), Y(3.6), X(12.75), Y(7.8)], radius=0.7 * s, fill=255)

    # head
    d.rounded_rectangle([X(4.4), Y(6.6), X(19.6), Y(19.4)], radius=3.4 * s, fill=255)

    # face: eyes + mouth punched out
    for ex in (9.1, 14.9):
        er = 1.6 * s
        cx, cy = X(ex), Y(12.1)
        d.ellipse([cx - er, cy - er, cx + er, cy + er], fill=0)
    d.rounded_rectangle(
        [X(9.3), Y(15.2), X(14.7), Y(16.3)], radius=0.55 * s, fill=0
    )
    return m


def make_robot(size: int, path: str):
    """Bare robot glyph — flat fill, no outline/shadow."""
    big = size * SS
    pad = big * 0.14
    glyph = robot_glyph_mask(big, pad)
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    fill = Image.new("RGBA", (big, big), (139, 92, 246, 255))
    img.paste(fill, (0, 0), glyph)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


def make_diamond(size: int, path: str, c1=(245, 158, 11), c2=(251, 146, 60)):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = big * 0.12
    pts = [(big / 2, m), (big - m, big / 2), (big / 2, big - m), (m, big / 2)]
    grad = grad_img(big, (*c1, 255), (*c2, 255))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    img.paste(grad, (0, 0), mask)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


def make_dot(size: int, path: str, c1=(34, 211, 238), c2=(45, 212, 191)):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    grad = grad_img(big, (*c1, 255), (*c2, 255))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse([big*0.1, big*0.1, big*0.9, big*0.9], fill=255)
    img.paste(grad, (0, 0), mask)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


def make_bars(size: int, path: str):
    """3 ascending bars — 'month' stats glyph."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    grad = grad_img(big, (167, 139, 250, 255), (34, 211, 238, 255))
    mask = Image.new("L", (big, big), 0)
    md = ImageDraw.Draw(mask)
    heights = [0.35, 0.6, 0.85]
    bw = big * 0.18
    gap = big * 0.13
    x0 = (big - 3 * bw - 2 * gap) / 2
    for i, h in enumerate(heights):
        x = x0 + i * (bw + gap)
        md.rounded_rectangle(
            [x, big * (1 - h), x + bw, big * 0.92],
            radius=bw * 0.4, fill=255,
        )
    img.paste(grad, (0, 0), mask)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


def make_infinity(size: int, path: str):
    """All-time glyph: infinity loop."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = int(big * 0.16)
    cy = big / 2
    r = big * 0.21
    off = big * 0.27
    for cx, col in [((big/2 - off), (34, 211, 238, 255)), ((big/2 + off), (167, 139, 250, 255))]:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=w)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


def make_tile(size: int, path: str):
    """Branded tray icon: rounded-square flat tile + white robot head."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # rounded square mask
    mask = Image.new("L", (big, big), 0)
    md = ImageDraw.Draw(mask)
    radius = big * 0.24
    md.rounded_rectangle(
        [big * 0.03, big * 0.03, big * 0.97, big * 0.97],
        radius=radius, fill=255,
    )

    # flat violet fill
    tile = Image.new("RGBA", (big, big), (139, 92, 246, 255))
    img.paste(tile, (0, 0), mask)

    # white robot head — no shadow, flat
    glyph = robot_glyph_mask(big, big * 0.17)
    white = Image.new("RGBA", (big, big), (255, 255, 255, 255))
    img.paste(white, (0, 0), glyph)

    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)


make_robot(64, "assets/icon-bare.png")
make_tile(128, "assets/icon.png")
print("done")
