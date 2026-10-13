"""Deterministic photo extraction and physical-size UV compositing.

Run with Python + Pillow + NumPy. A product config is required for new photos;
the included shirt3 landmarks were inspected against the supplied references.
No design is generated or reconstructed from guessed text.
"""
import argparse
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
CONFIG = {
    "shirt3": {
        "front": "shirt3-front.webp", "back": "shirt3-back.webp",
        "front_print_roi_px": [460, 185, 572, 240],
        "fabric_sample_rois_px": [[330, 300, 450, 550], [580, 300, 700, 550], [350, 580, 690, 740]],
        "torso_bbox_px": [255, 27, 770, 997],
        "hps_y_px": 27, "centerline_x_px": 512,
        "back_has_print": False,
    }
}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def extract_label(photo, roi):
    crop = photo.crop(roi).convert("RGBA")
    rgb = np.asarray(crop)[:, :, :3].astype(np.float32) / 255
    luminance = rgb.mean(axis=2)
    # The inspected black rubber patch is separated from brown cloth by
    # luminance. Keep the original patch pixels and embossed lettering.
    alpha = np.clip((.205 - luminance) / .04, 0, 1)
    mask = Image.fromarray(np.uint8(alpha * 255), "L")
    bbox = mask.point(lambda v: 255 if v > 220 else 0).getbbox()
    if bbox is None:
        raise RuntimeError("No confident print mask. Inspect the photo; do not invent a design.")
    # Margin removes all surrounding cloth while retaining antialiased edges.
    bbox = (max(bbox[0] - 1, 0), max(bbox[1] - 1, 0), min(bbox[2] + 1, crop.width), min(bbox[3] + 1, crop.height))
    crop.putalpha(mask)
    result = crop.crop(bbox)
    absolute = [bbox[0] + roi[0], bbox[1] + roi[1], bbox[2] + roi[0], bbox[3] + roi[1]]
    return result, absolute


def normal_map(layout, destination):
    size = layout["texture_size"][0]
    y, x = np.mgrid[:size, :size].astype(np.float32)
    # An original jersey stitch height field. ~1 mm columns, small amplitude;
    # normals, rather than photo shadows, carry the textile appearance.
    period = max(2.8, size * layout["uv_per_meter"] * .0018)
    phase_x = x / period * np.pi * 2
    phase_y = y / (period * 1.30) * np.pi * 2
    height = .10 * np.cos(phase_x + .6 * np.sin(phase_y)) * np.cos(phase_y)
    seam = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(seam)
    for island in layout["islands"]:
        u0, v0, u1, v1 = island["rect"]
        box = [round(u0 * size + 3), round((1 - v1) * size + 3), round(u1 * size - 3), round((1 - v0) * size - 3)]
        draw.rectangle(box, outline=180, width=2)
        if island["name"].startswith("sleeve_"):
            for offset in (4, 10):
                draw.line((box[0], box[1] + offset, box[2], box[1] + offset), fill=150, width=1)
        if island["name"] == "collar_rib":
            for xx in range(box[0], box[2], 3):
                draw.line((xx, box[1], xx, box[3]), fill=110, width=1)
    for path in layout.get("stitch_paths_uv", []):
        for row in (0, 1):
            inset = path.get("inset_v", 0) * (1 + row * .65)
            points = [(round(u * size), round((1 - v - inset) * size)) for u, v in path["points"]]
            draw.line(points, fill=160 if row == 0 else 105, width=2 if row == 0 else 1)
    height += np.asarray(seam.filter(ImageFilter.GaussianBlur(.7))) / 255 * .75
    dy, dx = np.gradient(height)
    vectors = np.stack((-dx, dy, np.ones_like(dx)), axis=2)
    vectors /= np.linalg.norm(vectors, axis=2, keepdims=True)
    encoded = np.uint8(np.clip((vectors * .5 + .5) * 255, 0, 255))
    Image.fromarray(encoded, "RGB").save(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", default="shirt3")
    parser.add_argument("--config", type=Path, help="JSON photo landmark config for another product")
    args = parser.parse_args()
    started = time.perf_counter()
    if Path(args.slug).name != args.slug or not args.slug:
        parser.error("slug must be a single directory name")
    config = json.loads(args.config.read_text(encoding="utf-8")) if args.config else CONFIG.get(args.slug)
    if not config:
        parser.error("An inspected landmark config is required for this product")
    photos = ROOT / "assets-src" / "photos"
    destination = ROOT / "public" / "products" / args.slug
    destination.mkdir(parents=True, exist_ok=True)
    report_dir = ROOT / "assets-src" / "reports" / args.slug
    report_dir.mkdir(parents=True, exist_ok=True)
    layout = json.loads((ROOT / "public" / "models" / "tee_uv_layout.json").read_text(encoding="utf-8"))
    front = Image.open(photos / config["front"]).convert("RGB")
    samples = np.concatenate([np.asarray(front.crop(roi)).reshape(-1, 3) for roi in config["fabric_sample_rois_px"]])
    color = tuple(int(v) for v in np.median(samples, axis=0))
    label, box = extract_label(front, config["front_print_roi_px"])
    label.save(destination / "print_front.png")
    if config["back_has_print"]:
        raise RuntimeError("Back print needs an inspected extraction mask; refusing to invent one")
    Image.new("RGBA", (1, 1), (0, 0, 0, 0)).save(destination / "print_back.png")
    island = next(i for i in layout["islands"] if i["name"] == "front")
    torso = config["torso_bbox_px"]
    scale_x = layout["dimensions"]["chest_flat_m"] / (torso[2] - torso[0])
    scale_y = layout["dimensions"]["length_m"] / (torso[3] - torso[1])
    width = label.width * scale_x
    height = label.height * scale_y
    top = (box[1] - config["hps_y_px"]) * scale_y
    offset = ((box[0] + box[2]) / 2 - config["centerline_x_px"]) * scale_x
    size = layout["texture_size"][0]
    uv_scale = layout["uv_per_meter"]
    center_u = island["centerline_u"] + offset * uv_scale
    top_v = island["hps_uv"][1] - top * uv_scale
    composite = Image.new("RGBA", (size, size), (*color, 255))
    stamp = label.resize((max(1, round(width * uv_scale * size)), max(1, round(height * uv_scale * size))), Image.Resampling.LANCZOS)
    xy = (round(center_u * size - stamp.width / 2), round((1 - top_v) * size))
    composite.alpha_composite(stamp, xy)
    composite.convert("RGB").save(destination / "basecolor.png")
    texture_dir = ROOT / "public" / "textures"
    texture_dir.mkdir(parents=True, exist_ok=True)
    normal_map(layout, texture_dir / "tee_normal.png")
    metadata = {
        "slug": args.slug, "baseColorHex": "#" + "".join(f"{v:02x}" for v in color),
        "basecolor": "basecolor.png", "print_front": "print_front.png", "print_back": "print_back.png",
        "prints": {"front": {"hps_distance_m": top, "width_m": width, "height_m": height,
                              "centerline_offset_m": offset, "source_bbox_px": box}, "back": None},
        "dimensions_source": layout["dimensions_source"], "dimensions": layout["dimensions"],
        "photos": [config["front"], config["back"]],
        "placement_method": "Inspected photo landmarks mapped separately in X/Y to default physical dimensions; not a measured garment",
        "license": "Owner-supplied third-party branded product photos; private repository/private demonstration only",
        "known_issues": ["Embossed black logo is only about 84 source pixels wide; original low-contrast details are retained without reconstruction", "Perspective/physical size estimates use supplied default dimensions; real measurements would improve accuracy"],
    }
    write_json(destination / "product.json", metadata)
    # A source comparison, extraction on a checker and complete UV atlas.
    preview = Image.new("RGB", (1200, 550), "#ecebe4")
    preview.paste(front.resize((500, 500)), (0, 25))
    preview.paste(composite.convert("RGB").resize((500, 500)), (700, 25))
    checker = Image.new("RGBA", (190, 150), "#dddddd")
    draw = ImageDraw.Draw(checker)
    for yy in range(0, 150, 10):
        for xx in range(0, 190, 10):
            if (xx // 10 + yy // 10) % 2:
                draw.rectangle((xx, yy, xx + 9, yy + 9), fill="#ffffff")
    enlarged = label.resize((168, round(label.height * 168 / label.width)), Image.Resampling.NEAREST)
    checker.alpha_composite(enlarged, (10, 50))
    preview.paste(checker.convert("RGB"), (505, 200))
    preview.save(report_dir / "texture-extraction-preview.png")
    write_json(report_dir / "texture-report.json", {"elapsed_seconds": round(time.perf_counter() - started, 3),
        "basecolor_size": [size, size], "normal_size": [size, size], "source_label_size": list(label.size),
        "photo_cloth_in_basecolor": False, "back_print": "Empty transparent image; photo back is plain",
        "method": "Source-only alpha extraction; pure median fabric color; original generated knit normal", "product": metadata})
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
