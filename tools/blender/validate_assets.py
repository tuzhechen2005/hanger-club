"""Validate shipped GLB structure, topology identity, UVs and clip timing."""
import argparse
import hashlib
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from glb import read, accessor

ROOT = Path(__file__).resolve().parents[2]


def garment_mesh(document):
    node = next(n for n in document["nodes"] if n.get("name") == "Garment")
    return document["meshes"][node["mesh"]]


def validate(directory):
    checks = {}
    static, sb = read(directory / "tee.glb")
    animated, ab = read(directory / "tee_anim.glb")
    sm, am = garment_mesh(static), garment_mesh(animated)
    checks["static_has_no_morph_targets"] = not static.get("animations") and all(not p.get("targets") for p in sm["primitives"])
    checks["same_primitive_count"] = len(sm["primitives"]) == len(am["primitives"])
    vertex_count, triangles, targets = 0, 0, set()
    bounds = []
    checks["base_attributes_identical"] = True
    checks["indices_identical"] = True
    for p, q in zip(sm["primitives"], am["primitives"]):
        checks["base_attributes_identical"] &= p["attributes"].keys() == q["attributes"].keys()
        for name in p["attributes"]:
            checks["base_attributes_identical"] &= np.array_equal(accessor(static, sb, p["attributes"][name]), accessor(animated, ab, q["attributes"][name]))
        checks["indices_identical"] &= np.array_equal(accessor(static, sb, p["indices"]), accessor(animated, ab, q["indices"]))
        positions = accessor(static, sb, p["attributes"]["POSITION"])
        bounds.append(positions)
        vertex_count += len(positions)
        triangles += len(accessor(static, sb, p["indices"])) // 3
        targets.add(len(q.get("targets", [])))
    checks["garment_vertices_at_most_10000"] = vertex_count <= 10000
    checks["garment_triangles_at_most_20000"] = triangles <= 20000
    checks["same_target_count_per_primitive"] = len(targets) == 1
    names = {n.get("name") for n in animated["nodes"]}
    checks["required_nodes"] = {"HookPivot", "Hanger", "HangerWood", "HangerHook", "Garment"} <= names
    nodes = {n.get("name"): n for n in animated["nodes"]}
    checks["root_hierarchy"] = {animated["nodes"][i]["name"] for i in nodes["HookPivot"]["children"]} == {"Garment", "Hanger"}
    checks["hanger_hierarchy"] = {animated["nodes"][i]["name"] for i in nodes["Hanger"]["children"]} == {"HangerWood", "HangerHook"}
    materials = {animated["materials"][p["material"]]["name"] for p in am["primitives"]}
    checks["fabric_material_slots"] = materials == {"Fabric", "FabricInner"}
    outer = next(p for p in am["primitives"] if animated["materials"][p["material"]]["name"] == "Fabric")
    position = accessor(animated, ab, outer["attributes"]["POSITION"])
    uv = accessor(animated, ab, outer["attributes"]["TEXCOORD_0"])
    # glTF stores the flipped texture V convention. Convert back to the
    # bottom-left UV convention used by the layout JSON before auditing.
    uv = uv.copy()
    uv[:, 1] = 1 - uv[:, 1]
    uv_details = {}
    for side, mask, direction in (("front", (uv[:, 0] <= .48001) & (uv[:, 1] >= .4), 1),
                                  ("back", (uv[:, 0] >= .51999) & (uv[:, 1] >= .4), -1)):
        values, tex = position[mask], uv[mask]
        horizontal = float(np.corrcoef(values[:, 0], tex[:, 0])[0, 1])
        vertical = float(np.corrcoef(values[:, 1], tex[:, 1])[0, 1])
        uv_details[side] = {"horizontal_uv_world_x_correlation": horizontal,
                            "vertical_uv_world_y_correlation": vertical,
                            "mean_gltf_z_m": float(values[:, 2].mean())}
        checks[f"{side}_uv_upright_and_nonmirrored"] = horizontal * direction > .95 and vertical > .95
    checks["front_faces_gltf_positive_z"] = uv_details["front"]["mean_gltf_z_m"] > uv_details["back"]["mean_gltf_z_m"]
    animations = {a["name"]: a for a in animated.get("animations", [])}
    checks["animation_names"] = set(animations) == {"lift", "return"}
    timing = {}
    for name, expected in (("lift", 1.5), ("return", 1.25)):
        animation = animations[name]
        times = [accessor(animated, ab, s["input"]).ravel() for s in animation["samplers"]]
        start = min(float(t.min()) for t in times)
        end = max(float(t.max()) for t in times)
        timing[name] = {"start_s": start, "end_s": end, "duration_s": end - start}
        checks[f"{name}_starts_at_zero"] = abs(start) < 1e-5
        checks[f"{name}_duration"] = abs(end - start - expected) < 1e-5
        checks[f"{name}_has_morph_animation"] = any(c["target"]["path"] == "weights" for c in animation["channels"])
    boundary = {}
    for path in ("translation", "rotation", "weights"):
        endpoints = []
        for name, endpoint in (("lift", -1), ("return", 0)):
            channel = next((c for c in animations[name]["channels"] if c["target"]["path"] == path), None)
            if channel is None and path == "rotation":
                endpoints.append(np.asarray(nodes["HookPivot"].get("rotation", [0, 0, 0, 1])))
                continue
            if channel is None:
                raise ValueError(f"Missing {name}/{path} channel")
            sampler = animations[name]["samplers"][channel["sampler"]]
            values = accessor(animated, ab, sampler["output"])
            times = accessor(animated, ab, sampler["input"])
            if path == "weights":
                values = values.reshape(len(times), -1)
            endpoints.append(values[endpoint])
        same = abs(float(np.dot(*endpoints))) > .99999 if path == "rotation" else np.allclose(*endpoints, atol=1e-6)
        checks[f"clip_boundary_{path}_continuous"] = bool(same)
    # Full revolution must retain sampled intermediate orientations; equal
    # start/end quaternions alone do not encode a 360-degree turn.
    lift = animations["lift"]
    rotation = next(c for c in lift["channels"] if c["target"]["path"] == "rotation")
    rotation_values = accessor(animated, ab, lift["samplers"][rotation["sampler"]]["output"])
    checks["lift_has_full_turn_samples"] = len(rotation_values) >= 24 and np.ptp(rotation_values[:, 1]) > 1.8
    image_info = []
    for image in animated.get("images", []):
        view = animated["bufferViews"][image["bufferView"]]
        offset = view.get("byteOffset", 0)
        data = ab[offset:offset + view["byteLength"]]
        decoded = Image.open(io.BytesIO(data))
        image_info.append({"name": image.get("name"), "size": list(decoded.size), "bytes": len(data)})
    checks["shared_textures_2048"] = sum(i["size"] == [2048, 2048] for i in image_info) >= 2
    checks["product_texture_not_embedded"] = not any("basecolor" in i["name"].lower() or "shirt3" in i["name"].lower() for i in image_info)
    for mat in animated["materials"]:
        if mat["name"] in {"Fabric", "FabricInner"}:
            checks[f"{mat['name']}_normal_and_orm"] = "normalTexture" in mat and "occlusionTexture" in mat and "metallicRoughnessTexture" in mat["pbrMetallicRoughness"]
    points = np.concatenate(bounds)
    result = {"checks": {k: bool(v) for k, v in checks.items()},
              "all_structural_checks_pass": bool(all(checks.values())),
              "garment_gltf_vertices": vertex_count, "garment_triangles": triangles,
              "morph_targets": sorted(targets), "animations": timing, "embedded_images": image_info,
              "uv_orientation": uv_details,
              "bounds_gltf_m": {"min": points.min(0).tolist(), "max": points.max(0).tolist()},
              "files": {name: {"bytes": (directory / name).stat().st_size,
                                "sha256": hashlib.sha256((directory / name).read_bytes()).hexdigest()}
                        for name in ("tee.glb", "tee_anim.glb")},
              "scope": "Structural GLB validation; collision, mirror correctness and visual quality require separate checks"}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "public" / "models")
    parser.add_argument("--report", type=Path, default=ROOT / "assets-src" / "reports" / "tee" / "validation.json")
    args = parser.parse_args()
    result = validate(args.directory)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["all_structural_checks_pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
