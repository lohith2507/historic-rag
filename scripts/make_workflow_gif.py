from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

W, H = 960, 540
BG = (247, 242, 233)
INK = (28, 40, 54)
MUTED = (90, 100, 112)
PAPER = (255, 252, 246)
ACCENT = (180, 95, 48)
LINE = (210, 200, 185)
GREEN = (46, 125, 90)
BLUE = (45, 90, 140)

steps = [
    ("1. Ingest PDFs", "Gita · Ramayana · Mahabharata\nchunk + embed offline"),
    ("2. Store vectors", "Supabase Postgres\n+ pgvector chunks"),
    ("3. Ask / Search", "User question in the\nHistoric India UI"),
    ("4. Retrieve", "Embed query → match_chunks\nranked epic passages"),
    ("5. Answer", "OpenRouter streams a\ngrounded chat reply"),
]

modes = ["More context", "Full battle story", "More encounters"]


def font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


title_f = font(28, True)
sub_f = font(16)
box_title = font(18, True)
box_body = font(14)
small = font(13)


def draw_base(draw: ImageDraw.ImageDraw, highlight: int = -1, show_modes: bool = False) -> None:
    draw.text((40, 28), "Historic India RAG — workflow", font=title_f, fill=INK)
    draw.text(
        (40, 68),
        "Offline ingest once · live search & grounded chat on Vercel",
        font=sub_f,
        fill=MUTED,
    )

    positions = [
        (40, 130),
        (360, 130),
        (680, 130),
        (200, 300),
        (520, 300),
    ]
    box_w, box_h = 240, 110

    for i, ((x, y), (title, body)) in enumerate(zip(positions, steps)):
        active = i == highlight or (show_modes and i >= 3)
        fill = (255, 245, 235) if active else PAPER
        outline = ACCENT if active else LINE
        draw.rounded_rectangle(
            (x, y, x + box_w, y + box_h),
            radius=18,
            fill=fill,
            outline=outline,
            width=3 if active else 2,
        )
        draw.text((x + 16, y + 16), title, font=box_title, fill=ACCENT if active else INK)
        draw.multiline_text((x + 16, y + 48), body, font=box_body, fill=MUTED, spacing=4)

    arrow_fill = BLUE if highlight in (1, 2) else MUTED
    for x in (290, 610):
        draw.polygon(
            [
                (x, 180),
                (x + 40, 180),
                (x + 40, 175),
                (x + 55, 185),
                (x + 40, 195),
                (x + 40, 190),
                (x, 190),
            ],
            fill=arrow_fill,
        )

    draw.line((800, 240, 800, 270), fill=MUTED, width=3)
    draw.line((800, 270, 640, 270), fill=MUTED, width=3)
    draw.line((640, 270, 640, 300), fill=MUTED, width=3)
    draw.line((320, 240, 320, 300), fill=MUTED, width=3)

    mid_fill = GREEN if highlight == 4 else MUTED
    draw.polygon(
        [
            (450, 350),
            (490, 350),
            (490, 345),
            (505, 355),
            (490, 365),
            (490, 360),
            (450, 360),
        ],
        fill=mid_fill,
    )

    if show_modes:
        draw.text((40, 450), "Chat follow-ups:", font=box_title, fill=INK)
        mx = 220
        for mode in modes:
            tw = draw.textlength(mode, font=small)
            draw.rounded_rectangle(
                (mx, 445, mx + tw + 24, 478),
                radius=12,
                fill=(236, 245, 240),
                outline=GREEN,
                width=2,
            )
            draw.text((mx + 12, 452), mode, font=small, fill=GREEN)
            mx += int(tw) + 36
    else:
        draw.text(
            (40, 455),
            "PDFs stay local · vectors in Supabase · app queries OpenRouter at runtime",
            font=small,
            fill=MUTED,
        )


def main() -> None:
    frames: list[Image.Image] = []

    for _ in range(8):
        img = Image.new("RGB", (W, H), BG)
        draw_base(ImageDraw.Draw(img), highlight=-1)
        frames.append(img)

    for i in range(5):
        for _ in range(10):
            img = Image.new("RGB", (W, H), BG)
            draw_base(ImageDraw.Draw(img), highlight=i)
            frames.append(img)

    for _ in range(14):
        img = Image.new("RGB", (W, H), BG)
        draw_base(ImageDraw.Draw(img), highlight=4, show_modes=True)
        frames.append(img)

    out = Path("docs/workflow.gif")
    out.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=120,
        loop=0,
        optimize=True,
    )
    print(f"wrote {out} bytes={out.stat().st_size} frames={len(frames)}")


if __name__ == "__main__":
    main()
