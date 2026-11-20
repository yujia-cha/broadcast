"""앱·트레이 아이콘 그림(스피커와 소리 물결). Pillow가 필요하다."""

from __future__ import annotations

TEAL = (14, 116, 144, 255)
ORANGE = (194, 65, 12, 255)
WHITE = (255, 255, 255, 255)


def app_icon(color: tuple[int, int, int, int] = TEAL, size: int = 64):
    from PIL import Image, ImageDraw

    scale = size / 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def s(*values: float) -> list[float]:
        return [v * scale for v in values]

    draw.rounded_rectangle(s(4, 4, 60, 60), radius=14 * scale, fill=color)
    draw.polygon([tuple(s(16, 26)), tuple(s(24, 26)), tuple(s(34, 17)), tuple(s(34, 47)), tuple(s(24, 38)), tuple(s(16, 38))], fill=WHITE)
    draw.arc(s(30, 20, 48, 44), start=-50, end=50, fill=WHITE, width=max(1, round(4 * scale)))
    return img
