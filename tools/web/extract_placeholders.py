"""Crude placeholder textures from product photos, until the Blender pipeline delivers.

For each `<slug>-front.*` (and `<slug>-back.*` when it is a plain flat shot) in
assets-src/photos, estimate the fabric color, cut the print out of the chest area
and record where it sits on the garment. Output goes to
public/products/<slug>/placeholder.json and placeholder-print-<side>.png.

This is NOT the spec section 5 pipeline: no perspective correction, no wrinkle
removal. It only exists so the web prototype shows recognizable garments.

Usage: python3 -I tools/web/extract_placeholders.py
"""
from pathlib import Path
import json

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
PHOTOS = ROOT / 'assets-src' / 'photos'
OUT = ROOT / 'public' / 'products'
# Back shots that are not usable flat product photos (worn by a model).
SKIP = {'shirt4-back'}


def lab_distance(a, b):
    return np.sqrt(((a.astype(np.float32) - b.astype(np.float32)) ** 2).sum(-1))


def analyse(path: Path):
    image = Image.open(path).convert('RGB')
    rgb = np.asarray(image)
    h, w, _ = rgb.shape
    corners = np.concatenate([rgb[:8, :8].reshape(-1, 3), rgb[:8, -8:].reshape(-1, 3),
                              rgb[-8:, :8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3)])
    background = np.median(corners, axis=0)
    garment = lab_distance(rgb, background) > 28
    mask = Image.fromarray(garment.astype(np.uint8) * 255).filter(ImageFilter.MedianFilter(5))
    # Fill holes (light prints close to the background color): background is only what touches the border.
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if mask.getpixel(corner) == 0:
            ImageDraw.floodfill(mask, corner, 128)
    garment = np.asarray(mask) != 128
    ys, xs = np.nonzero(garment)
    top, bottom, left, right = ys.min(), ys.max(), xs.min(), xs.max()
    length = bottom - top
    # Body (torso) columns: garment extent on the row 75% down, below the sleeves.
    row = top + int(length * 0.75)
    cols = np.nonzero(garment[row])[0]
    body_left, body_right = cols.min(), cols.max()
    body_width = body_right - body_left
    centre_x = (body_left + body_right) / 2

    # Fabric color: median of the torso below the chest, away from edges.
    sample = rgb[top + int(length * 0.55): top + int(length * 0.9),
                 body_left + int(body_width * 0.1): body_right - int(body_width * 0.1)]
    sample_mask = garment[top + int(length * 0.55): top + int(length * 0.9),
                          body_left + int(body_width * 0.1): body_right - int(body_width * 0.1)]
    fabric = np.median(sample[sample_mask], axis=0)

    # Print: strong deviation from the fabric color inside the chest area.
    region = (slice(top + int(length * 0.15), top + int(length * 0.8)),
              slice(body_left + int(body_width * 0.12), body_right - int(body_width * 0.12)))
    deviation = lab_distance(rgb, fabric)
    ink = np.zeros_like(garment)
    ink[region] = (deviation[region] > 38) & garment[region]
    # Drop heather speckle: keep pixels that survive an open (min then max) filter.
    ink = Image.fromarray(ink.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5))
    ink = np.asarray(ink) > 127
    result = {'fabric': '#%02x%02x%02x' % tuple(int(c) for c in fabric), 'print': None}
    rows = np.nonzero(ink.sum(1) > max(3, 0.01 * body_width))[0]
    cols = np.nonzero(ink.sum(0) > max(2, 0.01 * length))[0]
    if len(rows) and len(cols) and ink.sum() > 0.0008 * body_width * length:
        pad = 4
        y0, y1 = max(rows.min() - pad, 0), min(rows.max() + pad, h - 1)
        x0, x1 = max(cols.min() - pad, 0), min(cols.max() + pad, w - 1)
        crop = rgb[y0:y1 + 1, x0:x1 + 1]
        alpha = np.clip((deviation[y0:y1 + 1, x0:x1 + 1] - 30) / 24, 0, 1) * garment[y0:y1 + 1, x0:x1 + 1]
        alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(3))) / 255
        near_ink = Image.fromarray(ink[y0:y1 + 1, x0:x1 + 1].astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))
        alpha = alpha * (np.asarray(near_ink) > 127)
        rgba = np.dstack([crop, (alpha * 255).astype(np.uint8)])
        result['print'] = {
            'image': Image.fromarray(rgba),
            # Normalised to the torso: x from body centre in body widths, y from collar top in lengths.
            'centerX': float(((x0 + x1) / 2 - centre_x) / body_width),
            'top': float((y0 - top) / length),
            'width': float((x1 - x0) / body_width),
            'aspect': float((y1 - y0) / max(x1 - x0, 1)),
        }
    return result


def main():
    photos = sorted(p for p in PHOTOS.iterdir() if p.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp', '.avif'})
    by_slug = {}
    for path in photos:
        slug, _, side = path.stem.rpartition('-')
        if side not in {'front', 'back'} or path.stem in SKIP:
            continue
        by_slug.setdefault(slug, {})[side] = path
    for slug, sides in sorted(by_slug.items()):
        folder = OUT / slug
        folder.mkdir(parents=True, exist_ok=True)
        meta = {'slug': slug, 'source': {k: v.name for k, v in sides.items()}, 'placeholder': True}
        for side, path in sides.items():
            data = analyse(path)
            if side == 'front':
                meta['fabric'] = data['fabric']
            printed = data['print']
            if printed:
                printed['image'].save(folder / f'placeholder-print-{side}.png')
                meta[f'print_{side}'] = {k: round(v, 4) for k, v in printed.items() if k != 'image'}
        (folder / 'placeholder.json').write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
        print(slug, json.dumps(meta))


if __name__ == '__main__':
    main()
