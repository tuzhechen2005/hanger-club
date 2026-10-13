"""Export the product photos in assets-src/photos for the "original photo" proof in the page.

Writes public/products/<slug>/photo-<side>.webp: the studio sweep is keyed out to transparency
and the garment is cropped and centred on a 900 px square at the same scale for every product,
so the photos line up on the page and can develop straight over the 3D garment. The photos are third-party
brand images for the private demo only (docs/asset-spec.md §5); replace them before any launch.

    python tools/web/export_photos.py
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets-src" / "photos"


SIZE = 900
FILL = 0.86


def normalise(image):
    """Key out the background (sampled from the corners) to alpha and centre the garment."""
    pixels = np.asarray(image).astype(np.float32)
    h, w, _ = pixels.shape
    k = max(4, min(h, w) // 40)
    corners = np.concatenate([pixels[:k, :k], pixels[:k, -k:], pixels[-k:, :k], pixels[-k:, -k:]]).reshape(-1, 3)
    background = np.median(corners, axis=0)
    distance = np.linalg.norm(pixels - background, axis=2)
    # Soft key: fully background below 10, fully garment above 34 (8-bit units).
    alpha = np.clip((distance - 10) / 24, 0, 1)
    mask = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))
    box = mask.point(lambda v: 255 if v > 128 else 0).getbbox() or (0, 0, w, h)
    keyed = image.convert("RGBA")
    keyed.putalpha(mask)
    keyed = keyed.crop(box)
    scale = SIZE * FILL / max(keyed.size)
    keyed = keyed.resize((round(keyed.width * scale), round(keyed.height * scale)), Image.LANCZOS)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(keyed, ((SIZE - keyed.width) // 2, (SIZE - keyed.height) // 2))
    return out


def main():
    for path in sorted(SOURCE.iterdir()):
        if path.suffix.lower() not in {".webp", ".jpeg", ".jpg", ".png", ".avif"} or "-" not in path.stem:
            continue
        slug, side = path.stem.split("-", 1)
        if side not in {"front", "back"}:
            continue
        image = normalise(Image.open(path).convert("RGB"))
        out = ROOT / "public" / "products" / slug / f"photo-{side}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        image.save(out, "WEBP", quality=82, alpha_quality=90, method=6)
        print(f"{out.relative_to(ROOT)}  {image.size[0]}×{image.size[1]}  {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
