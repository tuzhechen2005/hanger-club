"""Export the product photos in assets-src/photos for the "original photo" proof in the page.

Writes public/products/<slug>/photo-<side>.webp (longest edge 1000 px). The photos are third-party
brand images for the private demo only (docs/asset-spec.md §5); replace them before any launch.

    python tools/web/export_photos.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets-src" / "photos"


def main():
    for path in sorted(SOURCE.iterdir()):
        if path.suffix.lower() not in {".webp", ".jpeg", ".jpg", ".png", ".avif"} or "-" not in path.stem:
            continue
        slug, side = path.stem.split("-", 1)
        if side not in {"front", "back"}:
            continue
        image = Image.open(path).convert("RGB")
        image.thumbnail((1000, 1000), Image.LANCZOS)
        out = ROOT / "public" / "products" / slug / f"photo-{side}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        image.save(out, "WEBP", quality=82, method=6)
        print(f"{out.relative_to(ROOT)}  {image.size[0]}×{image.size[1]}  {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
