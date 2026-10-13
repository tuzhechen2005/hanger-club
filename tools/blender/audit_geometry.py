"""Sample all baked poses for hanger penetration and surface intersections.

Nearest signed surface distance checks vertices and triangle centroids. It is
not a proof that an unsampled continuous-time mesh never intersects. The self
check uses BVH candidates followed by finite segment/triangle intersections;
coplanar contacts and adjacent triangles are deliberately excluded.
"""
from pathlib import Path
import argparse
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
import numpy as np
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_ray_tri


def pierces(a, b, triangle):
    direction = b - a
    length2 = direction.length_squared
    if length2 < 1e-16:
        return False
    hit = intersect_ray_tri(*triangle, direction, a, True)
    if hit is None:
        return False
    fraction = (hit - a).dot(direction) / length2
    return 1e-5 < fraction < 1 - 1e-5


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCES / "tee_animated.blend")
    parser.add_argument("--samples", type=Path, default=SOURCES / "tee_clip_samples.npz")
    parser.add_argument("--report", type=Path, default=REPORTS / "tee" / "geometry-audit.json")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    args.source, args.samples, args.report = args.source.resolve(), args.samples.resolve(), args.report.resolve()
    started = time.perf_counter()
    bpy.ops.wm.open_mainfile(filepath=str(args.source))
    garment = bpy.data.objects["Garment"]
    mesh = garment.data
    mesh.calc_loop_triangles()
    faces = [tuple(t.vertices) for t in mesh.loop_triangles]
    face_sets = [set(t) for t in faces]
    triangles = np.asarray(faces)
    samples = np.load(args.samples)["positions"]
    colliders = []
    for name in ("HangerWood", "HangerHook"):
        obj = bpy.data.objects[name]
        points = [v.co.copy() for v in obj.data.vertices]
        tree = BVHTree.FromPolygons(points, [list(p.vertices) for p in obj.data.polygons])
        coords = np.asarray(points)
        colliders.append((name, tree, coords.min(0) - .004, coords.max(0) + .004))
    frames = []
    for index, points in enumerate(samples):
        centroids = points[triangles].mean(1)
        probes = np.concatenate((points, centroids))
        collisions = {}
        for name, tree, low, high in colliders:
            nearby = probes[np.all((probes >= low) & (probes <= high), axis=1)]
            depths = []
            inside_points = []
            for point in nearby:
                probe = Vector(point)
                surface, normal, _, distance = tree.find_nearest(probe)
                if surface is not None and (probe - surface).dot(normal) < -.0002:
                    depths.append(distance)
                    inside_points.append(list(probe))
            collisions[name] = {"probes_inside_over_0_2mm": len(depths),
                                "max_depth_m": max(depths, default=0.),
                                "example_inside_points": inside_points[:5]}
        vectors = [Vector(p) for p in points]
        tree = BVHTree.FromPolygons(vectors, faces, all_triangles=True)
        count, examples = 0, []
        regions = []
        for i, j in tree.overlap(tree):
            if i >= j or face_sets[i] & face_sets[j]:
                continue
            a, b = [vectors[v] for v in faces[i]], [vectors[v] for v in faces[j]]
            if any(pierces(a[k], a[(k + 1) % 3], b) or
                   pierces(b[k], b[(k + 1) % 3], a) for k in range(3)):
                count += 1
                if len(examples) < 5:
                    examples.append([i, j])
                regions.extend([points[v].tolist() for v in faces[i] + faces[j]])
        frames.append({"sample": index, "hanger": collisions,
                       "nonadjacent_surface_crossings": count, "example_triangle_pairs": examples,
                       "crossing_bounds_blender_m": {"min": np.min(regions, axis=0).tolist(), "max": np.max(regions, axis=0).tolist()} if regions else None})
        if index % 12 == 0:
            print(f"AUDIT sample={index}/66 crossings={count}", flush=True)
    penetration_count = sum(v["probes_inside_over_0_2mm"] for f in frames for v in f["hanger"].values())
    crossing_count = sum(f["nonadjacent_surface_crossings"] for f in frames)
    save_json(args.report, {
        "sample_count": len(frames), "hanger_probe_count_per_sample": len(probes),
        "hanger_penetration_probe_total": penetration_count,
        "surface_crossing_pair_total": crossing_count,
        "all_sampled_checks_pass": penetration_count == 0 and crossing_count == 0,
        "method": __doc__, "elapsed_seconds": round(time.perf_counter() - started, 3),
        "frames": frames})


if __name__ == "__main__":
    main()
