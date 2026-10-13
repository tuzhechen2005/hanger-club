"""Simulate hanger motion and bake relative cloth positions into morph clips."""
import argparse
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from build_tee import cloth_settings, evaluated_vertices, solidify
from materials import shared_materials
from glb import static_derivative
from shells import ShellProbe
import numpy as np
from mathutils.bvhtree import BVHTree


def smooth(t):
    t = max(0., min(1., t))
    return t * t * (3 - 2 * t)


def pose(clip, t):
    if clip == "lift":
        if t <= .20:
            height, depth, angle = .07 * smooth(t / .20), 0., 0.
        elif t <= 1.10:
            f = smooth((t - .20) / .90)
            height, depth, angle = .07 - .02 * f, .60 * f, math.tau * f
        else:
            height, depth, angle = .05, .60, math.tau
    else:
        if t <= .70:
            f = smooth(t / .70)
            height, depth = .05 + .02 * f, .60 * (1 - f)
        elif t <= .85:
            height, depth = .07 * (1 - smooth((t - .70) / .15)), 0.
        else:
            height, depth = 0., 0.
        angle = math.tau
    # Blender Z-up, front -Y -> glTF Y-up, front +Z.
    return (0., -depth, height), angle


def nla_track(datablock, action, name, start):
    animation = datablock.animation_data_create()
    animation.action = None
    track = animation.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, start, action)
    strip.blend_type = "REPLACE"
    strip.extrapolation = "NOTHING"
    return track


def set_linear(action):
    for layer in action.layers:
        for strip in layer.strips:
            if strip.type != "KEYFRAME":
                continue
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = "LINEAR"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", default="tee", help="Garment kind: tee (build_tee.py) or a build_garment.py kind")
    parser.add_argument("--source", type=Path, help="Drape file (default: assets-src/blender/<kind>_drape.blend)")
    parser.add_argument("--warmup", type=int, default=121)
    parser.add_argument("--experiment", help="Isolated clip trial name")
    parser.add_argument("--settle-blend", type=int, default=8, help="Ease the last N return frames onto the base pose")
    parser.add_argument("--motion-stiffness", type=float, default=.3, help="Goal stiffness while the hanger moves; rests stay at 1")
    parser.add_argument("--motion-support", type=float, default=.80, help="Soft rest-shape support for stable web transitions (0..1)")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.warmup < 73:
        parser.error("At least 3 seconds of warmup are required")
    if not 0 <= args.motion_support <= 1:
        parser.error("motion-support must be between 0 and 1")
    started = time.perf_counter()
    kind = args.kind
    args.source = args.source or SOURCES / f"{kind}_drape.blend"
    out_models, out_sources, out_reports = MODELS, SOURCES, REPORTS / kind
    if args.experiment:
        if Path(args.experiment).name != args.experiment:
            parser.error("experiment must be a directory name")
        trial = ROOT / "assets-src" / "experiments" / args.experiment
        out_models, out_sources, out_reports = trial / "models", trial / "blender", trial / "reports" / kind
    for directory in (out_models, out_sources, out_reports):
        directory.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()))
    scene = bpy.context.scene
    scene.frame_set(1)
    pivot, garment = bpy.data.objects["HookPivot"], bpy.data.objects["Garment"]
    if "FabricThickness_2mm" in garment.modifiers:
        garment.modifiers.remove(garment.modifiers["FabricThickness_2mm"])
    last_frame = args.warmup + 36 + 30
    scene.frame_end = last_frame
    for frame in range(1, last_frame + 1):
        if frame <= args.warmup:
            location, angle = pose("lift", 0)
        elif frame <= args.warmup + 36:
            location, angle = pose("lift", (frame - args.warmup) / 24)
        else:
            location, angle = pose("return", (frame - args.warmup - 36) / 24)
        pivot.location = location
        pivot.rotation_euler = (0, 0, angle)
        pivot.keyframe_insert(data_path="location", frame=frame)
        pivot.keyframe_insert(data_path="rotation_euler", frame=frame)
    set_linear(pivot.animation_data.action)
    scene.frame_set(1)
    wood = bpy.data.objects["HangerWood"]
    wood_tree = BVHTree.FromPolygons([wood.matrix_world @ v.co for v in wood.data.vertices], [list(p.vertices) for p in wood.data.polygons])
    garment_to_world = garment.matrix_world.copy()
    support = garment.vertex_groups.new(name="MotionSupport")
    original_pin = garment.vertex_groups.get("HangerSupport")
    for vertex in garment.data.vertices:
        try:
            original_weight = original_pin.weight(vertex.index)
        except RuntimeError:
            original_weight = 0.
        # Longer garments (trousers) relax over their own length.
        vertical = max(0., min(1., (-vertex.co.z - .10) / max(.70, float(garment.get("length_m", .78)) - .08)))
        weight = max(original_weight, args.motion_support * (1 - .22 * vertical))
        # Cloth lying on the hanger moves with it; letting it lag during the 360° turn
        # only drives it into the wood.
        if garment.get("solver_profile") == "gravity":
            _, _, _, distance = wood_tree.find_nearest(garment_to_world @ vertex.co)
            if distance is not None and distance < .012:
                weight = 1.
        support.add([vertex.index], weight, "REPLACE")
    cloth = cloth_settings(garment, last_frame)
    cloth.settings.vertex_group_mass = support.name
    if garment.get("solver_profile") == "gravity":
        # The 360° turn moves the shoulders fast past the wood; more substeps keep
        # cloth/hanger contact resolved. The static drape does not need this.
        cloth.settings.quality = 20
        cloth.collision_settings.collision_quality = 6
    if args.motion_stiffness is not None:
        # Hold the rest shape while the hanger is still, loosen it while it travels and
        # turns so the cloth lags and swings, then tighten again so each clip settles back
        # onto the base mesh (the web swaps to the static mesh when a clip ends).
        w = args.warmup
        lift_travel = w + round(1.1 * 24)
        return_travel = w + 36 + round(.85 * 24)
        keys = [(1, 1.), (w, 1.), (w + 3, args.motion_stiffness), (lift_travel, args.motion_stiffness), (w + 36, 1.),
                (w + 39, args.motion_stiffness), (return_travel, args.motion_stiffness), (last_frame, 1.)]
        for frame, value in keys:
            cloth.settings.pin_stiffness = value
            cloth.settings.keyframe_insert("pin_stiffness", frame=frame)
    # The tee's pins and clearances keep it off the wood; other kinds (hood roots on the shoulders,
    # waistbands in the clips) also need relaxing to push cloth back out of the hanger.
    probe = ShellProbe(garment, solidify, collider=wood if kind != "tee" else None, clearance=.006)
    samples, original_mesh, previous, velocities = [], None, None, {}
    relaxed = []
    for frame in range(1, last_frame + 1):
        scene.frame_set(frame)
        points = evaluated_vertices(garment)
        assert np.isfinite(points).all()
        if frame >= args.warmup:
            # Relax only creases whose 2 mm shells would cross, then solidify exactly as exported.
            single, solid, iterations, left = probe.resolve(points)
            assert left == 0, f"frame {frame}: {left} solidified shell crossings remain"
            relaxed.append(float(np.linalg.norm(single - points, axis=1).max()))
            samples.append(solid)
            if original_mesh is None:
                original_mesh = probe.evaluated_mesh_copy(single)
            assert len(solid) == len(samples[0]), "Topology changed during simulation"
        if frame in (args.warmup, args.warmup + 36, last_frame) and previous is not None:
            velocities[str(frame)] = float(np.max(np.linalg.norm(points - previous, axis=1)) * 24)
        if frame % 12 == 1 or frame == last_frame:
            print(f"CLIP frame={frame}/{last_frame} elapsed={time.perf_counter()-started:.1f}s", flush=True)
        previous = points.copy()
    if args.settle_blend:
        # The web swaps to the static base mesh when `return` ends, so its last frames
        # ease exactly onto the base pose. The goal stiffness is already ramping up here.
        n = args.settle_blend
        for k in range(1, n + 1):
            a = k / n
            a = a * a * (3 - 2 * a)
            i = len(samples) - n - 1 + k
            samples[i] = samples[i] * (1 - a) + samples[0] * a
    probe.remove()
    np.savez_compressed(out_sources / f"{kind}_clip_samples.npz", positions=np.stack(samples))
    # Bake ambient occlusion in the stationary pose on the outer single layer.
    scene.frame_set(args.warmup)
    camera = studio()
    shared_materials(garment, bake_ao=True, name=kind)
    material_refs = list(garment.data.materials)
    bpy.data.objects.remove(garment, do_unlink=True)
    garment = bpy.data.objects.new("Garment", original_mesh)
    bpy.context.collection.objects.link(garment)
    garment.parent = pivot
    material_indices = [p.material_index for p in garment.data.polygons]
    garment.data.materials.clear()
    for mat in material_refs:
        garment.data.materials.append(mat)
    for polygon, index in zip(garment.data.polygons, material_indices):
        polygon.material_index = index
    garment.data.vertices.foreach_set("co", samples[0].ravel())
    garment.data.update()
    garment.shape_key_add(name="Basis").value = 0
    blocks = []
    for i, points in enumerate(samples[1:], 1):
        block = garment.shape_key_add(name=f"Sample_{i:02d}")
        block.value = 0
        block.data.foreach_set("co", points.ravel())
        blocks.append(block)
    pivot.animation_data_clear()
    for clip, duration_frames, start, sample_offset in (("lift", 36, 0, 0), ("return", 30, 50, 36)):
        # Morph weights are one-hot per frame; first lift frame is all zero.
        keys = garment.data.shape_keys
        keys.animation_data_create()
        keys.animation_data.action = None
        for frame in range(duration_frames + 1):
            selected = sample_offset + frame - 1
            for index, block in enumerate(blocks):
                block.value = 1. if selected >= 0 and index == selected else 0.
                block.keyframe_insert(data_path="value", frame=frame)
        action = keys.animation_data.action
        action.name = clip + ".morph"
        set_linear(action)
        nla_track(keys, action, clip, start)
        pivot.animation_data_create()
        pivot.animation_data.action = None
        for frame in range(duration_frames + 1):
            location, angle = pose(clip, frame / 24)
            pivot.location, pivot.rotation_euler = location, (0, 0, angle)
            pivot.keyframe_insert(data_path="location", frame=frame)
            pivot.keyframe_insert(data_path="rotation_euler", frame=frame)
        action = pivot.animation_data.action
        action.name = clip + ".rigid"
        set_linear(action)
        nla_track(pivot, action, clip, start)
    for block in blocks:
        block.value = 0
    scene.frame_start, scene.frame_end = 0, 80
    scene.frame_set(0)
    pivot.location, pivot.rotation_euler = (0, 0, 0), (0, 0, 0)
    bpy.ops.wm.save_as_mainfile(filepath=str(out_sources / f"{kind}_animated.blend"))
    export_glb(out_models / f"{kind}_anim.glb", descendants(pivot), animated=True)
    static_derivative(out_models / f"{kind}_anim.glb", out_models / f"{kind}.glb")
    relative_displacement = np.linalg.norm(np.stack(samples) - samples[0], axis=2)
    save_json(out_reports / "animation-report.json", {
        "blender_version": bpy.app.version_string, "warmup_frames": args.warmup - 1,
        "shape_targets": len(blocks), "clips": {"lift": 1.5, "return": 1.25},
        "relative_frame_vertex_max_velocities_m_s": velocities,
        "max_relative_displacement_m": float(relative_displacement.max()),
        "crease_relaxation_max_shift_m": max(relaxed) if relaxed else 0.,
        "motion_support": args.motion_support, "motion_stiffness_while_moving": args.motion_stiffness, "return_settle_blend_frames": args.settle_blend,
        "clip_boundary_sample": "Both clips reference the same simulated sample 36 at the transition",
        "return_end_base_rms_m": float(np.sqrt(np.mean((samples[-1] - samples[0]) ** 2))),
        "return_end_base_max_m": float(np.linalg.norm(samples[-1] - samples[0], axis=1).max()),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "static_export_method": "Prune animation/target buffers from the exact animated GLB; base attributes and indices are unchanged",
        "known_issues": ["Solver parameters are tuned for visual medium cotton, not physically calibrated", "Motion uses soft rest-shape restraints to keep the web transition controlled; it is not unrestrained cloth", "Inspect end-pose residual motion and self-collision in rendered contact sheets before acceptance"],
    })


if __name__ == "__main__":
    main()
