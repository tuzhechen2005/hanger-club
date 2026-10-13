"""Build the shared wooden hanger, with a separate swivel hook and collision meshes."""
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *


def tube(name, points, radius_a, radius_b, mat, parent, sides=10):
    vertices, faces = [], []
    for i, point in enumerate(points):
        direction = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])
        direction.normalize()
        axis = Vector((0, 1, 0)) if name == "HangerWood" else Vector((1, 0, 0))
        other = direction.cross(axis).normalized()
        for j in range(sides):
            theta = j * math.tau / sides
            vertices.append(Vector(point) + axis * (radius_a * math.cos(theta)) + other * (radius_b * math.sin(theta)))
        if i:
            for j in range(sides):
                a = (i - 1) * sides + j
                b = (i - 1) * sides + (j + 1) % sides
                faces.append((a, b, i * sides + (j + 1) % sides, i * sides + j))
    faces.extend([tuple(reversed(range(sides))), tuple((len(points) - 1) * sides + j for j in range(sides))])
    obj = mesh_object(name, vertices, faces, mat, parent)
    # Recalculate outward normals for both sweep orientations.
    select_only([obj])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    uv = obj.data.uv_layers.new(name="UVMap")
    for polygon in obj.data.polygons:
        for loop_index in polygon.loop_indices:
            vi = obj.data.loops[loop_index].vertex_index
            uv.data[loop_index].uv = (vi // sides / (len(points) - 1), vi % sides / sides)
    obj.modifiers.new("ClothCollision", "COLLISION")
    obj.collision.thickness_outer = .0015
    obj.collision.thickness_inner = .001
    obj.collision.cloth_friction = 12
    return obj


def build(parent=None):
    hanger = empty("Hanger", parent)
    wood = material("Wood", (.22, .085, .028), .55)
    # Real baked wood color, so glTF does not lose a procedural-only shader.
    import numpy as np
    size = 512
    yy, xx = np.mgrid[:size, :size] / size
    grain = np.sin(yy * 210 + 3 * np.sin(xx * 8) + np.sin(xx * 27))
    fine = np.sin(yy * 1300 + np.sin(xx * 33))
    rgba = np.ones((size, size, 4), dtype=np.float32)
    for channel, value in enumerate((.48, .29, .15)):
        rgba[:, :, channel] = value + .018 * grain + .006 * fine
    image = bpy.data.images.new("WoodGrain", size, size, alpha=True)
    image.pixels.foreach_set(rgba.ravel())
    image.pack()
    tex = wood.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    wood.node_tree.links.new(tex.outputs["Color"], wood.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    # Elliptical shoulder cross-section: 22 mm deep, 14 mm tall.
    points = [(x, 0, -.082 - .050 * (abs(x) / .22) ** 1.28) for x in [-.22 + i * .44 / 40 for i in range(41)]]
    wood_obj = tube("HangerWood", points, .011, .007, wood, hanger, sides=12)
    extent = max(abs(v.co.x) for v in wood_obj.data.vertices)
    for vertex in wood_obj.data.vertices:
        vertex.co.x *= .22 / extent
    metal = material("Metal", (.65, .68, .72), .25, 1)
    # Blender -Y corresponds to glTF +Z (forward). Ring inner apex is z=0.
    points = [(0, 0, -.082), (0, 0, -.060), (0, 0, -.047)]
    for i in range(1, 10):
        t = i / 9
        points.append((0, -.013 * (t * t * (3 - 2 * t)), -.047 + .023 * t))
    points.append((0, -.013, -.011))
    for theta in sorted([math.radians(228) * i / 57 for i in range(1, 58)] + [math.pi / 2]):
        points.append((0, -.013 * math.cos(theta), -.011 + .013 * math.sin(theta)))
    tube("HangerHook", points, .002, .002, metal, hanger, sides=12)
    hanger["contact_point_m"] = [0., 0., 0.]
    hanger["hook_inner_radius_m"] = .011
    hanger["original_asset"] = "Procedurally authored for Hanger Club; no external assets"
    return hanger


def main():
    started = time.perf_counter()
    reset()
    hanger = build()
    meshes = [obj for obj in descendants(hanger) if obj.type == "MESH"]
    counts = {obj.name: stats(obj) for obj in meshes}
    assert sum(v["triangles"] for v in counts.values()) <= 3000
    export_glb(MODELS / "hanger.glb", descendants(hanger))
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / "hanger.blend"))
    report_dir = REPORTS / "hanger"
    camera = studio(target=(0, 0, -.075), width=.56, resolution=640)
    render(report_dir / "front.png", camera, target=(0, 0, -.075), elevation=0)
    render(report_dir / "three-quarter.png", camera, azimuth=.7, target=(0, 0, -.075))
    render(report_dir / "side.png", camera, azimuth=math.pi / 2, target=(0, 0, -.075), elevation=0)
    save_json(report_dir / "report.json", {
        "blender_version": bpy.app.version_string, "meshes": counts,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "source": "Original scripted wood and hook; original generated wood texture; studio area lights, no HDRI",
        "origin": "Inner crown contact (0,0,0), hook metal top approximately +0.004 m",
        "checks": {"triangle_budget": True, "separate_hook": True, "width_m": .44},
        "known_issues": ["Low-poly end caps are rounded by elliptical section; not a manufacturing CAD model"],
    })


if __name__ == "__main__":
    main()
