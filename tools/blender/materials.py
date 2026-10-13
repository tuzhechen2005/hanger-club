"""Bake shared drape AO and connect portable glTF material channels."""
import numpy as np
from common import *


def shared_materials(garment, bake_ao=False, name="tee"):
    """ORM (baked drape AO) and knit normal for one garment kind: <name>_orm.png, <name>_normal.png."""
    texture_dir = ROOT / "public" / "textures"
    texture_dir.mkdir(parents=True, exist_ok=True)
    size = 2048
    if bake_ao:
        image = bpy.data.images.new("DrapeAO", size, size, alpha=True)
        image.colorspace_settings.name = "Non-Color"
        for mat in garment.data.materials:
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = image
            mat.node_tree.nodes.active = node
            node.select = True
        select_only([garment])
        scene = bpy.context.scene
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 32
        scene.render.bake.margin = 8
        # Bake the OUTER single layer, avoiding overlapping inner/outer UVs.
        modifier = garment.modifiers.get("FabricThickness_2mm")
        if modifier:
            modifier.show_render = modifier.show_viewport = False
        bpy.ops.object.bake(type="AO", margin=8, use_clear=True)
        if modifier:
            modifier.show_render = modifier.show_viewport = True
        pixels = np.empty(size * size * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(size, size, 4)
        # Empty UV regions are white; mapped regions carry the actual AO.
        valid = pixels[:, :, 3] > .5
        ao = np.where(valid, pixels[:, :, 0], 1.)
        rgba = np.ones((size, size, 4), dtype=np.float32)
        rgba[:, :, 0], rgba[:, :, 1], rgba[:, :, 2] = ao, .85, 0
        orm = bpy.data.images.new("ORM", size, size, alpha=True)
        orm.colorspace_settings.name = "Non-Color"
        orm.pixels.foreach_set(rgba.ravel())
        orm.filepath_raw = str(texture_dir / f"{name}_orm.png")
        orm.file_format = "PNG"
        orm.save()
    else:
        orm = bpy.data.images.load(str(texture_dir / f"{name}_orm.png"), check_existing=True)
    orm.colorspace_settings.name = "Non-Color"
    orm.pack()
    normal = bpy.data.images.load(str(texture_dir / f"{name}_normal.png"), check_existing=True)
    normal.colorspace_settings.name = "Non-Color"
    normal.pack()
    group = bpy.data.node_groups.get("glTF Material Output")
    if not group:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        group.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
        group.nodes.new("NodeGroupInput")
        group.nodes.new("NodeGroupOutput")
    for mat in garment.data.materials:
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = nodes.get("Principled BSDF")
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = orm
        separate = nodes.new("ShaderNodeSeparateColor")
        links.new(texture.outputs["Color"], separate.inputs["Color"])
        links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
        settings = nodes.new("ShaderNodeGroup")
        settings.node_tree = group
        links.new(separate.outputs["Red"], settings.inputs["Occlusion"])
        normal_tex = nodes.new("ShaderNodeTexImage")
        normal_tex.image = normal
        normal_node = nodes.new("ShaderNodeNormalMap")
        normal_node.inputs["Strength"].default_value = .40
        links.new(normal_tex.outputs["Color"], normal_node.inputs["Color"])
        links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])


def use_product_texture(garment, slug="shirt3"):
    image = bpy.data.images.load(str(ROOT / "public" / "products" / slug / "basecolor.png"), check_existing=True)
    for mat in garment.data.materials:
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        color = texture.outputs["Color"]
        if mat.name.startswith("FabricInner"):
            multiply = nodes.new("ShaderNodeMixRGB")
            multiply.blend_type = "MULTIPLY"
            multiply.inputs[0].default_value = 1
            multiply.inputs[2].default_value = (.72, .72, .72, 1)
            links.new(color, multiply.inputs[1])
            color = multiply.outputs[0]
        links.new(color, nodes.get("Principled BSDF").inputs["Base Color"])
