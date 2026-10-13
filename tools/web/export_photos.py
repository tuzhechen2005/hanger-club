"""Export the product photos in assets-src/photos for the "original photo" proof in the page.

Writes public/products/<slug>/photo-<side>.webp: the studio sweep is keyed out to transparency
and the garment is cropped and centred on a 900 px square at the same scale for every product,
so the photos line up on the page and can develop straight over the 3D garment. The photos are third-party
brand images for the private demo only (docs/asset-spec.md §5); replace them before any launch.

    python tools/web/export_photos.py
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets-src" / "photos"


SIZE = 900
FILL = 0.86


def key_backdrop(image):
    """Soft key against a plain studio sweep, sampled from the corners."""
    pixels = np.asarray(image).astype(np.float32)
    h, w, _ = pixels.shape
    k = max(4, min(h, w) // 40)
    corners = np.concatenate([pixels[:k, :k], pixels[:k, -k:], pixels[-k:, :k], pixels[-k:, -k:]]).reshape(-1, 3)
    background = np.median(corners, axis=0)
    distance = np.linalg.norm(pixels - background, axis=2)
    # Fully background below 10, fully garment above 34 (8-bit units).
    alpha = np.clip((distance - 10) / 24, 0, 1)
    return Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))


def segment(image):
    """GrabCut for photos on walls, sheets or gradients, where a colour key fails."""
    import cv2

    pixels = np.asarray(image)[:, :, ::-1].copy()
    h, w = pixels.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    inset = max(2, min(h, w) // 100)
    rect = (inset, inset, w - 2 * inset, h - 2 * inset)
    cv2.grabCut(pixels, mask, rect, np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64), 6, cv2.GC_INIT_WITH_RECT)
    garment = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    # Keep the largest piece (the garment), drop specks, soften the edge a little.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(garment)
    if count > 1:
        largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        garment = np.where(labels == largest, 255, 0).astype(np.uint8)
    garment = cv2.GaussianBlur(garment, (0, 0), 1.2)
    return Image.fromarray(garment)


def normalise(image, hints=None):
    """Cut the garment out to alpha and centre it at a common scale."""
    hints = hints or {}
    if "crop" in hints:
        w, h = image.size
        l, t, r, b = hints["crop"]
        image = image.crop((round(l * w), round(t * h), round(r * w), round(b * h)))
    w, h = image.size
    mask = segment(image) if hints.get("grabcut") else key_backdrop(image)
    if hints.get("erode"):
        mask = mask.filter(ImageFilter.MinFilter(2 * int(hints["erode"]) + 1)).filter(ImageFilter.GaussianBlur(1))
    if hints.get("drop_light"):
        hsv = np.asarray(image.convert("HSV")).astype(np.float32) / 255
        pale = (hsv[:, :, 2] > 0.72) & (hsv[:, :, 1] < 0.18)
        if "keep_light" in hints:
            l, t, r, b = hints["keep_light"]
            pale[round(t * h):round(b * h), round(l * w):round(r * w)] = False
        mask = Image.fromarray(np.where(pale, 0, np.asarray(mask)).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))
    box = mask.point(lambda v: 255 if v > 128 else 0).getbbox() or (0, 0, w, h)
    keyed = image.convert("RGBA")
    keyed.putalpha(mask)
    keyed = keyed.crop(box)
    scale = SIZE * FILL / max(keyed.size)
    keyed = keyed.resize((round(keyed.width * scale), round(keyed.height * scale)), Image.LANCZOS)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(keyed, ((SIZE - keyed.width) // 2, (SIZE - keyed.height) // 2))
    return out


def fabric_colour(image):
    """Median colour of the cut-out garment, skipping its brightest 20 % (highlights, trims, type)."""
    pixels = np.asarray(image).astype(float)
    rgb = pixels[:, :, :3][pixels[:, :, 3] > 200]
    lum = rgb @ [.3, .59, .11]
    colour = np.median(rgb[lum < np.percentile(lum, 80)], axis=0).round().astype(int)
    return "#%02x%02x%02x" % tuple(colour)


def garment_box(image):
    """Bounding box of the opaque garment, as fractions of the square [left, top, right, bottom]."""
    box = image.getchannel("A").point(lambda v: 255 if v > 128 else 0).getbbox() or (0, 0, SIZE, SIZE)
    return [round(v / SIZE, 4) for v in box]


def main():
    boxes = {}
    hints = json.loads((SOURCE / "cutout.json").read_text()) if (SOURCE / "cutout.json").exists() else {}
    for path in sorted(SOURCE.iterdir()):
        if path.suffix.lower() not in {".webp", ".jpeg", ".jpg", ".png", ".avif"} or "-" not in path.stem:
            continue
        slug, side = path.stem.split("-", 1)
        if side not in {"front", "back"}:
            continue
        image = normalise(Image.open(path).convert("RGB"), hints.get(path.stem))
        out = ROOT / "public" / "products" / slug / f"photo-{side}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        image.save(out, "WEBP", quality=82, alpha_quality=90, method=6)
        boxes.setdefault(slug, {})[side] = garment_box(image)
        # A new product's base colour (existing placeholder.json files also hold print placements).
        placeholder = out.parent / "placeholder.json"
        if side == "front" and not placeholder.exists():
            placeholder.write_text(json.dumps({"slug": slug, "fabric": fabric_colour(image),
                                               "source": "median colour of the cut-out photo"}, indent=1) + "\n")
        print(f"{out.relative_to(ROOT)}  {image.size[0]}×{image.size[1]}  {out.stat().st_size // 1024} KB")
    # Where the garment sits in each square: the page lines the photo up with the 3D garment.
    for slug, sides in boxes.items():
        (ROOT / "public" / "products" / slug / "photos.json").write_text(json.dumps({"bbox": sides}, indent=1) + "\n")


if __name__ == "__main__":
    main()
