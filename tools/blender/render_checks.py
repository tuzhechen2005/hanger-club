"""Render six stationary views, both clips and the re-imported exported GLB."""
import argparse
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from materials import use_product_texture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCES / "tee_animated.blend")
    parser.add_argument("--model", type=Path, default=MODELS / "tee_anim.glb")
    parser.add_argument("--output", type=Path, default=REPORTS / "tee")
    parser.add_argument("--slug", default="shirt3")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    args.source, args.model, args.output = args.source.resolve(), args.model.resolve(), args.output.resolve()
    started = time.perf_counter()
    args.output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()))
    garment = bpy.data.objects["Garment"]
    use_product_texture(garment, args.slug)
    scene = bpy.context.scene
    scene.frame_set(0)
    camera = studio(resolution=768)
    for name, angle in (("front", 0), ("back", math.pi), ("left", -math.pi / 2),
                        ("right", math.pi / 2), ("front-three-quarter", -.65), ("back-three-quarter", math.pi - .65)):
        render(args.output / f"{name}.png", camera, angle, elevation=0)
    for name, target, width, angle in (("detail-neck", (0, 0, -.15), .36, -.15),
                                      ("detail-cuff", (-.38, 0, -.40), .28, -.35),
                                      ("detail-hem", (0, 0, -.76), .56, -.12)):
        camera.data.ortho_scale = width
        render(args.output / f"{name}.png", camera, angle, target=target, elevation=0)
    camera.data.ortho_scale = 1.25
    scene.render.resolution_x = scene.render.resolution_y = 384
    for clip, count, start in (("lift", 36, 0), ("return", 30, 50)):
        frames = list(range(0, count + 1, 4))
        if frames[-1] != count:
            frames.append(count)
        for frame in frames:
            scene.frame_set(start + frame)
            render(args.output / clip / f"frame-{frame:02d}.png", camera, elevation=0)
    # Import the delivered file into a clean scene, rather than rendering the
    # authored scene a second time and calling that an export check.
    reset()
    bpy.ops.import_scene.gltf(filepath=str(args.model.resolve()))
    garment = bpy.data.objects["Garment"]
    use_product_texture(garment, args.slug)
    scene = bpy.context.scene
    scene.frame_set(0)
    camera = studio(resolution=768)
    render(args.output / "reimport-front.png", camera, elevation=0)
    render(args.output / "reimport-three-quarter.png", camera, -.65, elevation=0)
    save_json(args.output / "render-report.json", {"blender_version": bpy.app.version_string,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "source": args.source.as_posix(), "reimported_model": args.model.as_posix(),
        "lighting": "Original area-light studio; no external HDRI", "product_texture": args.slug,
        "view_count": 6, "clip_sample_interval_frames": 4,
        "background_postprocess": "compose_reports.py composites alpha onto exact #ecebe4"})


if __name__ == "__main__":
    main()
