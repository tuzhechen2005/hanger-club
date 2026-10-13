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
import numpy as np


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
    parser.add_argument("--source", type=Path, default=SOURCES / "tee_drape.blend")
    parser.add_argument("--warmup", type=int, default=73)
    parser.add_argument("--experiment", help="Isolated clip trial name")
    parser.add_argument("--motion-support", type=float, default=.80, help="Soft rest-shape support for stable web transitions (0..1)")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.warmup < 73:
        parser.error("At least 3 seconds of warmup are required")
    if not 0 <= args.motion_support <= 1:
        parser.error("motion-support must be between 0 and 1")
    started = time.perf_counter()
    out_models, out_sources, out_reports = MODELS, SOURCES, REPORTS / "tee"
    if args.experiment:
        if Path(args.experiment).name != args.experiment:
            parser.error("experiment must be a directory name")
        trial = ROOT / "assets-src" / "experiments" / args.experiment
        out_models, out_sources, out_reports = trial / "models", trial / "blender", trial / "reports" / "tee"
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
    support = garment.vertex_groups.new(name="MotionSupport")
    original_pin = garment.vertex_groups.get("HangerSupport")
    for vertex in garment.data.vertices:
        try:
            original_weight = original_pin.weight(vertex.index)
        except RuntimeError:
            original_weight = 0.
        vertical = max(0., min(1., (-vertex.co.z - .10) / .70))
        weight = max(original_weight, args.motion_support * (1 - .22 * vertical))
        support.add([vertex.index], weight, "REPLACE")
    cloth = cloth_settings(garment, last_frame)
    cloth.settings.vertex_group_mass = support.name
    solidify(garment)
    samples, original_mesh, previous, velocities = [], None, None, {}
    for frame in range(1, last_frame + 1):
        scene.frame_set(frame)
        points = evaluated_vertices(garment)
        assert np.isfinite(points).all()
        if frame >= args.warmup:
            samples.append(points.copy())
            if original_mesh is None:
                evaluated = garment.evaluated_get(bpy.context.evaluated_depsgraph_get())
                mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=bpy.context.evaluated_depsgraph_get())
                original_mesh = mesh.copy()
                evaluated.to_mesh_clear()
            assert len(points) == len(samples[0]), "Topology changed during simulation"
        if frame in (args.warmup, args.warmup + 36, last_frame) and previous is not None:
            velocities[str(frame)] = float(np.max(np.linalg.norm(points - previous, axis=1)) * 24)
        if frame % 12 == 1 or frame == last_frame:
            print(f"CLIP frame={frame}/{last_frame} elapsed={time.perf_counter()-started:.1f}s", flush=True)
        previous = points.copy()
    np.savez_compressed(out_sources / "tee_clip_samples.npz", positions=np.stack(samples))
    # Bake ambient occlusion in the stationary pose on the outer single layer.
    scene.frame_set(args.warmup)
    camera = studio()
    shared_materials(garment, bake_ao=True)
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
    bpy.ops.wm.save_as_mainfile(filepath=str(out_sources / "tee_animated.blend"))
    export_glb(out_models / "tee_anim.glb", descendants(pivot), animated=True)
    static_derivative(out_models / "tee_anim.glb", out_models / "tee.glb")
    relative_displacement = np.linalg.norm(np.stack(samples) - samples[0], axis=2)
    save_json(out_reports / "animation-report.json", {
        "blender_version": bpy.app.version_string, "warmup_frames": args.warmup - 1,
        "shape_targets": len(blocks), "clips": {"lift": 1.5, "return": 1.25},
        "relative_frame_vertex_max_velocities_m_s": velocities,
        "max_relative_displacement_m": float(relative_displacement.max()),
        "motion_support": args.motion_support,
        "clip_boundary_sample": "Both clips reference the same simulated sample 36 at the transition",
        "return_end_base_rms_m": float(np.sqrt(np.mean((samples[-1] - samples[0]) ** 2))),
        "return_end_base_max_m": float(np.linalg.norm(samples[-1] - samples[0], axis=1).max()),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "static_export_method": "Prune animation/target buffers from the exact animated GLB; base attributes and indices are unchanged",
        "known_issues": ["Solver parameters are tuned for visual medium cotton, not physically calibrated", "Motion uses soft rest-shape restraints to keep the web transition controlled; it is not unrestrained cloth", "Inspect end-pose residual motion and self-collision in rendered contact sheets before acceptance"],
    })


if __name__ == "__main__":
    main()
