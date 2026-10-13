"""Run with blender -b --factory-startup -P tools/blender/preflight.py."""

import argparse
import json
from pathlib import Path
import sys
import time

import bpy


def main():
    started = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slug", default="shirt3")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    root = Path(__file__).resolve().parents[2]
    photos = root / "assets-src" / "photos"
    if Path(args.slug).name != args.slug or not args.slug:
        parser.error("slug must be a single directory name")
    checks = {
        "blender_at_least_4_2": bpy.app.version >= (4, 2, 0),
        "background_mode": bpy.app.background,
        "cloth_modifier_available": hasattr(bpy.types, "ClothModifier"),
        "gltf_export_available": hasattr(bpy.ops.export_scene, "gltf"),
        "gltf_import_available": hasattr(bpy.ops.import_scene, "gltf"),
    }
    inputs = []
    for side in ("front", "back"):
        matches = sorted(p for p in photos.glob(f"{args.slug}-{side}.*")
                         if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".avif"})
        checks[f"{side}_photo_present"] = bool(matches)
        for path in matches:
            image = bpy.data.images.load(str(path), check_existing=False)
            inputs.append({"path": path.relative_to(root).as_posix(),
                           "dimensions_px": list(image.size), "bytes": path.stat().st_size})
            checks[f"{side}_photo_decodes"] = all(image.size)
            bpy.data.images.remove(image)
    report = {
        "stage": "preflight",
        "blender_version": bpy.app.version_string,
        "blender_build_hash": bpy.app.build_hash.decode(),
        "checks": checks,
        "inputs": inputs,
        "measurements_provided": (photos / f"{args.slug}-measurements.json").exists(),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "asset_acceptance_status": "not_started",
        "pending_spec_decision": "Allow hook metal above the contact-point origin; see docs/blender-preflight.md.",
    }
    destination = root / "assets-src" / "reports" / "preflight" / "report.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not all(checks.values()):
        raise RuntimeError("Preflight failed; inspect the report before building assets")


if __name__ == "__main__":
    main()
