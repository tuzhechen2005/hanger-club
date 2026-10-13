"""Composite exact warm-gray backgrounds and make labeled review sheets."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[2]


def sheet(paths, destination, columns=5, width=320):
    paths = list(paths)
    rows = (len(paths) + columns - 1) // columns
    result = Image.new("RGB", (columns * width, rows * (width + 28)), "#ecebe4")
    draw = ImageDraw.Draw(result)
    for i, path in enumerate(paths):
        x, y = i % columns * width, i // columns * (width + 28)
        image = ImageOps.contain(Image.open(path).convert("RGB"), (width, width))
        result.paste(image, (x, y))
        draw.text((x + 8, y + width + 5), path.stem, fill="#3f473c")
    result.save(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "assets-src" / "reports" / "tee")
    args = parser.parse_args()
    for path in args.directory.rglob("*.png"):
        if path.name.endswith("contact-sheet.png"):
            continue
        source = Image.open(path).convert("RGBA")
        background = Image.new("RGBA", source.size, "#ecebe4")
        background.alpha_composite(source)
        background.convert("RGB").save(path)
    for clip in ("lift", "return"):
        paths = sorted((args.directory / clip).glob("frame-*.png"))
        if paths:
            sheet(paths, args.directory / f"{clip}-contact-sheet.png")
    names = ("front", "back", "left", "right", "front-three-quarter", "back-three-quarter")
    sheet([args.directory / f"{name}.png" for name in names], args.directory / "static-contact-sheet.png", columns=3)


if __name__ == "__main__":
    main()
