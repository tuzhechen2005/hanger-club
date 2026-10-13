"""Shared, deterministic Blender asset helpers (no machine-specific paths)."""
import json
import math
from pathlib import Path
import time

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public" / "models"
SOURCES = ROOT / "assets-src" / "blender"
REPORTS = ROOT / "assets-src" / "reports"


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1
    bpy.context.scene.render.fps = 24
    for directory in (MODELS, SOURCES, REPORTS):
        directory.mkdir(parents=True, exist_ok=True)


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def material(name, color, roughness=.55, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def empty(name, parent=None):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    return obj


def mesh_object(name, vertices, faces, mat=None, parent=None, edges=()):
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(vertices, edges, faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    if mat:
        mesh.materials.append(mat)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return obj


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[-1]


def descendants(obj):
    return [obj] + [sub for child in obj.children for sub in descendants(child)]


def export_glb(path, objects, animated=False):
    select_only(objects)
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=False, export_texcoords=True,
        export_normals=True, export_tangents=False, export_materials="EXPORT",
        export_animations=animated, export_animation_mode="NLA_TRACKS",
        export_force_sampling=True, export_frame_range=False,
        export_anim_slide_to_zero=True,
        export_morph=animated, export_morph_normal=animated,
        export_morph_tangent=False, export_extras=True,
    )


def stats(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    points = [obj.matrix_world @ v.co for v in mesh.vertices]
    return {"vertices": len(mesh.vertices), "triangles": len(mesh.loop_triangles),
            "bounds_blender_m": {"min": [min(p[i] for p in points) for i in range(3)],
                                  "max": [max(p[i] for p in points) for i in range(3)]}}


def studio(target=(0, 0, -.43), width=1.25, resolution=768):
    scene = bpy.context.scene
    # Authoring files can already contain this rig. Replacing it keeps source
    # and clean GLB re-import renders under the same illumination.
    for obj in list(scene.objects):
        if obj.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.get_devices()
        for device in prefs.devices:
            device.use = device.type == "CUDA"
        if any(d.type == "CUDA" for d in prefs.devices):
            scene.cycles.device = "GPU"
    except Exception:
        pass
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("StudioWorld")
    world.use_nodes = True
    # Scene-linear warm grey, using the requested sRGB reference background.
    world.node_tree.nodes["Background"].inputs[0].default_value = (.84, .83, .78, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = .25
    scene.world = world
    for name, location, energy, size in [
        ("Key", (-2, -1.2, 1.3), 240, 1.4),
        ("Fill", (1.6, -.5, .4), 60, 1.5),
        ("Rim", (0, 1.8, .8), 110, 1.5),
    ]:
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.shape, light.size = energy, "DISK", size
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    camera_data = bpy.data.cameras.new("CheckCamera")
    camera_data.type, camera_data.ortho_scale = "ORTHO", width
    camera = bpy.data.objects.new("CheckCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    return camera


def render(path, camera, azimuth=0, target=(0, 0, -.43), elevation=.08):
    camera.location = (target[0] + math.sin(azimuth) * 2, target[1] - math.cos(azimuth) * 2, target[2] + elevation)
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.render.filepath = str(path.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
