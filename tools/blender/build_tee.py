"""Sew five final-resolution pattern pieces, then drape using Blender Cloth.

The seam welding happens BEFORE simulation. No remeshing, decimation or
subdivision is performed after simulation. Solidify uses the identical mesh
and modifier settings for every sampled pose.
"""
import argparse
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from build_hanger import build as build_hanger
import numpy as np
from mathutils.bvhtree import BVHTree

DEFAULTS = dict(length_m=.70, chest_flat_m=.62, shoulder_m=.60,
                sleeve_m=.24, sleeve_opening_m=.24, hem_flat_m=.61, rib_width_m=.025)


class PatternAssembly:
    def __init__(self):
        self.vertices, self.faces, self.face_uvs, self.face_parts = [], [], [], []
        self.lookup = {}
        self.welded_seam_references = 0

    def vertex(self, coordinate):
        key = tuple(round(v, 7) for v in coordinate)
        if key not in self.lookup:
            self.lookup[key] = len(self.vertices)
            self.vertices.append(coordinate)
        else:
            self.welded_seam_references += 1
        return self.lookup[key]

    def face(self, indices, uvs, part):
        self.faces.append(indices)
        self.face_uvs.append(uvs)
        self.face_parts.append(part)


def build_patterns(dimensions, parent, profile="baseline", drape_support=.33, collar_support=.6, sleeve_support=.3):
    d = dimensions
    pattern = PatternAssembly()
    columns, rows, arm_rows = 44, 40, 14
    neck_start, neck_end = 12, 32
    half = d["chest_flat_m"] / 2
    hps, hem = -.084, -.084 - d["length_m"]
    neck = .105
    # Height of cloth lying on the hanger's top surface (the shoulder-seam pins sit here).
    on_wood = lambda a: -.082 - .050 * (a / .22) ** 1.28 + .007 + .008
    # All islands use the same UV/m scale. Their *allowed* regions are fixed;
    # unused margins preserve isotropic texel density rather than stretching.
    density = min(.48 / d["chest_flat_m"], .60 / d["length_m"])
    islands, stitch_paths = [], []
    body = {}

    def paper_x(j):
        if j < neck_start:
            return -half + (half - neck) * j / neck_start
        if j <= neck_end:
            return -neck + 2 * neck * (j - neck_start) / (neck_end - neck_start)
        return neck + (half - neck) * (j - neck_end) / (columns - neck_end)

    for side, sign, u0 in (("front", -1, 0.), ("back", 1, .52)):
        grid = []
        for k in range(rows + 1):
            row = []
            t = k / rows
            for j in range(columns + 1):
                x0 = paper_x(j)
                if neck_start <= j <= neck_end:
                    a = max(0., 1 - (x0 / neck) ** 2) ** .5
                    top = hps - (.080 if side == "front" else .025) * a
                    # Gravity profile: the neckline hangs nearly in the panel plane, so the
                    # rib and the panel below it stay together instead of forming a shelf.
                    y_top = sign * (.03 if profile == "gravity" else .045) * a
                elif profile == "gravity":
                    # Shoulder seam rests on the hanger's top surface, then falls away past its tip.
                    ax = abs(x0)
                    blend = 1 - (min(ax, .21) - neck) / (.21 - neck)
                    top = on_wood(min(ax, .21)) + (hps - on_wood(neck)) * blend - .9 * max(0., ax - .24)
                    y_top = 0.
                else:
                    top = hps - .044 * (abs(x0) - neck) / (half - neck)
                    y_top = 0.
                z = top * (1 - t) + hem * t
                # Initial assembly is a sewn envelope. This is not the final
                # drape; the cloth solver determines the wrinkles afterwards.
                cross = max(0., 1 - (x0 / half) ** 2) ** .5
                arm = .038 * math.sin(math.pi * k / arm_rows) if k <= arm_rows else 0.
                if profile == "gravity":
                    # Front/back hang as nearly flat sheets just clearing the hanger;
                    # gravity and the solver make the folds, not the start shape.
                    y_bulk = sign * (.018 * cross ** .5 + arm * .5 * (1 - cross))
                    # Rows are ~17 mm apart while the hanger bar is 14 mm tall: the first rows
                    # under the shoulder seam must clear the bar's faces, or the triangle from
                    # the seam to the next row cuts through its rounded top edge.
                    over_bar = max(0., min(1., (.25 - abs(x0)) / .03))
                    y_bulk += sign * .014 * max(0., 1 - t / .08) * over_bar
                else:
                    y_bulk = sign * (.064 * cross + arm * (1 - cross))
                ramp = min(t / .12, 1)
                top_blend = math.sqrt(max(0., 1 - (1 - ramp) ** 2))
                y = y_top * (1 - top_blend) + y_bulk * top_blend
                if j in (0, columns):
                    y = sign * arm
                # A small deterministic asymmetry seeds physical buckling.
                if 0 < k < rows and 0 < j < columns and profile == "gravity":
                    y += .0006 * math.sin(x0 * 71 + k * .7) * math.sin(math.pi * t)
                elif 0 < k < rows and 0 < j < columns:
                    y += .0003 * math.sin(x0 * 71 + k * .7) * math.sin(math.pi * t)
                    envelope = math.sin(math.pi * t / 2) ** .7
                    side_folds = (.026 * math.exp(-((x0 + .205 + .008 * t) / .046) ** 2) +
                                  .029 * math.exp(-((x0 - .215 + .010 * t) / .055) ** 2))
                    edge_fade = min(1., (half - abs(x0)) / .035)
                    y += sign * side_folds * envelope * edge_fade
                    y += .006 * math.sin(x0 * 24 + .4) * envelope * cross
                # The turned hem retains a gentle hanging curve rather than
                # an exactly straight, paper-cut lower edge.
                z += .004 * (1 - math.cos(x0 / half * math.pi)) / 2 * t ** 10
                if k == rows - 1:
                    y += sign * .0015
                elif k == rows:
                    y -= sign * .001
                x = x0 * (1 - t * (1 - d["hem_flat_m"] / d["chest_flat_m"]))
                row.append(pattern.vertex((x, y, z)))
            grid.append(row)
        body[side] = grid
        def outline_uv(k, j):
            px = paper_x(j) if side == "front" else -paper_x(j)
            return [u0 + (px + half) * density, .40 + (pattern.vertices[grid[k][j]][2] - hem) * density]
        stitch_paths.extend([
            {"name": side + "_shoulder_neck", "points": [outline_uv(0, j) for j in range(columns + 1)], "inset_v": -.0025 * density},
            {"name": side + "_hem", "points": [outline_uv(rows, j) for j in range(columns + 1)], "inset_v": .004 * density},
        ])
        for k in range(rows):
            for j in range(columns):
                indices = [grid[k][j], grid[k + 1][j], grid[k + 1][j + 1], grid[k][j + 1]]
                uvs = []
                for kk, jj in ((k, j), (k + 1, j), (k + 1, j + 1), (k, j + 1)):
                    # Viewed directly from the back, the right side of the
                    # printed image points toward world -X.
                    px = paper_x(jj) if side == "front" else -paper_x(jj)
                    pz = pattern.vertices[grid[kk][jj]][2]
                    uvs.append((u0 + (px + half) * density, .40 + (pz - hem) * density))
                if sign == 1:
                    indices.reverse()
                    uvs.reverse()
                pattern.face(indices, uvs, side)
        islands.append({"name": side, "allowed_rect": [u0, .40, u0 + .48, 1.],
                        "rect": [u0, .40, u0 + d["chest_flat_m"] * density, .40 + d["length_m"] * density],
                        "physical_size_m": [d["chest_flat_m"], d["length_m"]],
                        "hps_uv": [u0 + (half + neck) * density, .40 + d["length_m"] * density],
                        "centerline_u": u0 + half * density,
                        "upright": True, "mirrored": False})

    # Sleeve patterns: unrolled rectangles, with two underarm edges sewn
    # together and their armhole boundary sewn onto front/back body edges.
    for side, col, sign, u0 in (("sleeve_left", 0, -1, .02), ("sleeve_right", columns, 1, .53)):
        boundary = ([body["front"][k][col] for k in range(arm_rows + 1)] +
                    [body["back"][k][col] for k in range(arm_rows - 1, 0, -1)])
        n = len(boundary)
        base = [Vector(pattern.vertices[i]) for i in boundary]
        center = sum(base, Vector()) / n
        if profile == "gravity":
            axis = Vector((sign * .53, 0, -.848)).normalized()
            cross = Vector((sign * .848, 0, .53)).normalized()
        else:
            axis = Vector((sign * .35, 0, -.9367497)).normalized()
            cross = Vector((sign * .9367497, 0, .35)).normalized()
        ring_count = 12
        grid = [boundary]
        circumference = sum((base[(i + 1) % n] - base[i]).length for i in range(n))
        distances = [0.]
        for i in range(n):
            distances.append(distances[-1] + (base[(i + 1) % n] - base[i]).length)
        for r in range(1, ring_count + 1):
            t = r / ring_count
            ring = []
            for i in range(n):
                theta = math.tau * i / n
                # Flat cuff width is half the circumference, rather than the
                # diameter of its assembled opening. Preserve that dimension
                # while giving the hanging opening a gently oval cross-section.
                a, b = (.09, .022) if profile == "gravity" else (.085, .068)
                perimeter = math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))
                scale = 2 * d["sleeve_opening_m"] / perimeter
                cuff = center + axis * d["sleeve_m"] + cross * (a * scale * math.cos(theta))
                cuff.y = -b * scale * math.sin(theta)
                point = base[i].lerp(cuff, t)
                # Round the upper sleeve cap into the shoulder tangent. The
                # linear assembled sleeve produced an angular shoulder peak.
                cap = max(0., math.cos(theta)) * t * (1 - t) ** 2
                if profile != "gravity":
                    point += Vector((sign * .04, 0., .24)) * cap
                # Two pre-simulation edge loops give cuffs a turned hem.
                if r == ring_count - 1:
                    point += (point - (center + axis * d["sleeve_m"])).normalized() * .0015
                ring.append(pattern.vertex(tuple(point)))
            grid.append(ring)
        for r in range(ring_count):
            for i in range(n):
                ni = (i + 1) % n
                indices = [grid[r][i], grid[r + 1][i], grid[r + 1][ni], grid[r][ni]]
                uvs = [(u0 + distances[ii] * density, .025 + rr / ring_count * d["sleeve_m"] * density)
                       for rr, ii in ((r, i), (r + 1, i), (r + 1, i + 1), (r, i + 1))]
                if sign == -1:
                    indices.reverse()
                    uvs.reverse()
                pattern.face(indices, uvs, side)
        islands.append({"name": side, "rect": [u0, .025, u0 + circumference * density, .025 + d["sleeve_m"] * density],
                        "physical_size_m": [circumference, d["sleeve_m"]]})

    boundary = ([body["front"][0][j] for j in range(neck_start, neck_end + 1)] +
                [body["back"][0][j] for j in range(neck_end - 1, neck_start, -1)])
    n = len(boundary)
    grid = [boundary]
    rib_steps = 4
    for r in range(1, rib_steps + 1):
        ring = []
        for vi in boundary:
            point = Vector(pattern.vertices[vi])
            depth = .080 if point.y < 0 else .025
            inward = Vector((-point.x / neck ** 2, 0, (hps - point.z) / depth ** 2)).normalized()
            point += inward * (d["rib_width_m"] * r / rib_steps)
            ring.append(pattern.vertex(tuple(point)))
        grid.append(ring)
    circumference = sum((Vector(pattern.vertices[boundary[(i + 1) % n]]) - Vector(pattern.vertices[boundary[i]])).length for i in range(n))
    for r in range(rib_steps):
        for i in range(n):
            ni = (i + 1) % n
            pattern.face([grid[r][i], grid[r][ni], grid[r + 1][ni], grid[r + 1][i]],
                         [(.02 + ii / n * circumference * density, .29 + rr / rib_steps * d["rib_width_m"] * density)
                          for rr, ii in ((r, i), (r, i + 1), (r + 1, i + 1), (r + 1, i))], "collar_rib")
    islands.append({"name": "collar_rib", "rect": [.02, .29, .02 + circumference * density, .29 + d["rib_width_m"] * density],
                    "physical_size_m": [circumference, d["rib_width_m"]]})
    fabric = material("Fabric", (.13, .095, .072), .85)
    inner = material("FabricInner", (.10, .073, .056), .85)
    # Separate the paper pieces before simulation. Each has a true planar
    # rest shape in physical units. Loose sewing edges join matching seam
    # vertices; the solver pulls them together without locking a curved
    # assembled envelope into the bending rest state.
    vertices, faces, rest_positions, seam_edges = [], [], [], []
    vertex_map, seam_map = {}, {}
    for face, coords, part in zip(pattern.faces, pattern.face_uvs, pattern.face_parts):
        indices = []
        for old_index, uv_coord in zip(face, coords):
            key = (part, old_index, round(uv_coord[0], 6), round(uv_coord[1], 6))
            if key not in vertex_map:
                index = len(vertices)
                vertex_map[key] = index
                vertices.append(pattern.vertices[old_index])
                rest_positions.append((uv_coord[0] / density, 0., uv_coord[1] / density))
                if old_index in seam_map:
                    seam_edges.append((seam_map[old_index], index))
                else:
                    seam_map[old_index] = index
            indices.append(vertex_map[key])
        faces.append(indices)
    if profile in ("baseline", "gravity"):
        vertices, faces, seam_edges = pattern.vertices, pattern.faces, []
    garment = mesh_object("Garment", vertices, faces, fabric, parent, edges=seam_edges)
    garment.data.materials.append(inner)
    uv = garment.data.uv_layers.new(name="UVMap")
    for polygon, coords in zip(garment.data.polygons, pattern.face_uvs):
        for index, coord in zip(polygon.loop_indices, coords):
            uv.data[index].uv = coord
    # Consistent outward normals before physics (no topology changes).
    select_only([garment])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Lock diagonals before simulation. Opposite triangulations of warped
    # outer/inner quads can otherwise cross after Solidify and GLB export.
    triangulate = garment.modifiers.new("FixedPatternTriangles", "TRIANGULATE")
    triangulate.quad_method = "FIXED"
    bpy.ops.object.modifier_apply(modifier=triangulate.name)
    garment["pattern_pieces"] = ["front", "back", "sleeve_left", "sleeve_right", "collar_rib"]
    garment["solver_profile"] = profile
    garment["seam_method"] = ("Five pattern pieces joined by matching boundary vertices before simulation"
                              if profile != "sewn" else "Five planar rest patterns joined with loose-edge Blender sewing springs; no post-simulation welding")
    garment["welded_seam_references"] = pattern.welded_seam_references if profile != "sewn" else 0
    garment["sewing_edges"] = len(seam_edges)
    garment["simulation_vertex_count"] = len(garment.data.vertices)
    if profile == "sewn":
        garment.shape_key_add(name="Basis")
        rest = garment.shape_key_add(name="RestPattern")
        rest.value = 0
        for point, position in zip(rest.data, rest_positions):
            point.co = position
    pin = garment.vertex_groups.new(name="HangerSupport")
    sleeve_vertices = {i for face, part in zip(pattern.faces, pattern.face_parts)
                       if part.startswith("sleeve_") for i in face}
    body_vertices = {i for face, part in zip(pattern.faces, pattern.face_parts)
                     if part in {"front", "back"} for i in face}
    free_sleeve_vertices = sleeve_vertices - body_vertices
    # Support patches on the shoulders, with soft falloff. Neck and body
    # remain free. These are a repeatable hanger contact stabilization aid.
    for v in garment.data.vertices:
        x, y, z = v.co
        hanger_top = -.082 - .050 * (abs(x) / .22) ** 1.28 + .007
        if profile == "baseline":
            vertical = max(0., min(1., (-z - .10) / .70))
            weight = .22 if v.index in free_sleeve_vertices else max(drape_support, .78 - 1.8 * vertical)
            pin.add([v.index], weight, "REPLACE")
        if profile == "gravity":
            # The shoulder seam lying on top of the wood is held. Everything else gets
            # a weak grooming goal toward the hung start shape, fading toward the hem
            # so folds and swing come from the solver.
            if abs(y) < 1e-6 and .115 <= abs(x) <= .215 and z > hanger_top - .012:
                v.co.z = hanger_top + .008
                pin.add([v.index], 1., "REPLACE")
            else:
                fall = max(0., min(1., (-z - .10) / .65))
                weight = drape_support * (1 - .7 * fall)
                # Sleeves get less: they should droop and swing, not hold their start pose.
                # Too little and they wander forward into the neighbours on the rail.
                if v.index in free_sleeve_vertices:
                    weight *= sleeve_support
                pin.add([v.index], weight, "REPLACE")
            continue
        if .105 <= abs(x) <= .235 and z > hanger_top - .004 and abs(y) < .026:
            v.co.z = max(v.co.z, hanger_top + .004)
            pin.add([v.index], 1., "REPLACE")
    garment["drape_support"] = drape_support
    if profile == "gravity":
        # Seams carry a doubled seam allowance and stitching, so they bend less than
        # plain jersey. Stiffer seams keep the underarm and shoulder from creasing
        # tighter than the 2 mm fabric thickness.
        parts_of = {}
        for face, part in zip(pattern.faces, pattern.face_parts):
            for i in face:
                parts_of.setdefault(i, set()).add(part)
        seam = {i for i, parts in parts_of.items() if len(parts) > 1}
        ring = {i for face in pattern.faces if seam & set(face) for i in face} - seam
        stiff = garment.vertex_groups.new(name="SeamStiffness")
        stiff.add(sorted(seam), 1., "REPLACE")
        stiff.add(sorted(ring), .5, "REPLACE")
    # Fit the initial shoulder envelope around the actual closed hanger mesh
    # before physics. A rest-shape constraint must not start inside its collider.
    wood = bpy.data.objects["HangerWood"].data
    wood_tree = BVHTree.FromPolygons([v.co for v in wood.vertices], [list(p.vertices) for p in wood.polygons])
    for vertex in garment.data.vertices:
        if abs(vertex.co.x) > .23 or abs(vertex.co.y) > .025 or vertex.co.z < -.15:
            continue
        surface, normal, _, distance = wood_tree.find_nearest(vertex.co)
        signed = (vertex.co - surface).dot(normal)
        if signed < .0035 and distance < .012:
            vertex.co = surface + normal * .0035
            # Gravity profile: this only pushes cloth out of the wood; the shoulder
            # seam pins above do the holding, so cloth beside the wood stays free.
            if profile != "gravity":
                pin.add([vertex.index], 1., "REPLACE")
    # Ribbing resists stretching more than the body jersey. A soft rest-shape
    # constraint preserves the curved opening without adding render topology.
    rib_vertices = {i for face, part in zip(pattern.faces, pattern.face_parts)
                    if part == "collar_rib" for i in face}
    if profile in ("baseline", "gravity"):
        rib_weight = .9 if profile == "baseline" else collar_support
        for index in rib_vertices:
            try:
                weight = pin.weight(index)
            except RuntimeError:
                weight = 0
            pin.add([index], max(weight, rib_weight), "REPLACE")
    if garment.data.shape_keys:
        for point, vertex in zip(garment.data.shape_keys.key_blocks["Basis"].data, garment.data.vertices):
            point.co = vertex.co
    seam_vertices = {i for edge in seam_edges for i in edge}
    exclusion = garment.vertex_groups.new(name="SewingCollisionExclusion")
    excluded = {i for face in faces if any(i in seam_vertices for i in face) for i in face}
    if excluded:
        exclusion.add(sorted(excluded), 1., "REPLACE")
    layout = {"schema_version": 1, "units": "m", "uv_origin": "bottom_left",
              "texture_size": [2048, 2048], "uv_per_meter": density,
              "dimensions": d, "dimensions_source": "default", "islands": islands, "stitch_paths_uv": stitch_paths,
              "notes": "Allowed UV regions contain isotropic physical-size rectangles; unused margins are intentional."}
    save_json(MODELS / "tee_uv_layout.json", layout)
    return garment, layout


def cloth_settings(garment, end_frame=241):
    cloth = garment.modifiers.new("CottonCloth", "CLOTH")
    s = cloth.settings
    if garment.data.shape_keys and "RestPattern" in garment.data.shape_keys.key_blocks:
        s.rest_shape_key = garment.data.shape_keys.key_blocks["RestPattern"]
    s.use_sewing_springs = True
    s.sewing_force_max = 1
    s.quality = 20
    # Blender's mass is per vertex, not kg/m² (cloth.cc assigns it to
    # each ClothVertex). Convert the requested 200 g/m² fabric explicitly.
    garment.data.calc_loop_triangles()
    area = sum(tri.area for tri in garment.data.loop_triangles)
    s.mass = .20 * area / len(garment.data.vertices)
    s.tension_stiffness = 12
    s.compression_stiffness = 12
    s.shear_stiffness = 5
    s.bending_stiffness = .02
    s.tension_damping = 6
    s.compression_damping = 6
    s.shear_damping = 6
    s.bending_damping = .8
    s.air_damping = .25
    s.vertex_group_mass = "HangerSupport"
    s.pin_stiffness = 1
    if garment.get("solver_profile") == "baseline":
        s.quality = 10
        s.mass = .20
        s.tension_stiffness = 35
        s.compression_stiffness = 35
        s.shear_stiffness = 18
        s.bending_stiffness = .35
        s.tension_damping = 12
        s.compression_damping = 12
        s.shear_damping = 10
        s.air_damping = 3
        s.use_sewing_springs = False
    if garment.get("solver_profile") == "gravity":
        s.quality = 12
        s.mass = float(garment.get("mass_override", .06))
        s.tension_stiffness = 60
        s.compression_stiffness = 40
        s.shear_stiffness = 20
        s.tension_damping = 5
        s.compression_damping = 5
        s.shear_damping = 5
        s.bending_damping = .5
        s.air_damping = 4
        s.use_sewing_springs = False
        if "SeamStiffness" in garment.vertex_groups:
            s.vertex_group_bending = "SeamStiffness"
    if "bending_override" in garment:
        s.bending_stiffness = garment["bending_override"]
    if s.vertex_group_bending:
        s.bending_stiffness_max = s.bending_stiffness * 5
    c = cloth.collision_settings
    c.use_collision = True
    c.distance_min = .002
    c.collision_quality = 4
    c.use_self_collision = True
    c.self_distance_min = .003
    c.self_friction = 5
    if "SewingCollisionExclusion" in garment.vertex_groups:
        c.vertex_group_self_collisions = "SewingCollisionExclusion"
    cloth.point_cache.frame_start = 1
    cloth.point_cache.frame_end = end_frame
    return cloth


def evaluated_vertices(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    result = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", result)
    evaluated.to_mesh_clear()
    return result.reshape(-1, 3)


def solidify(garment):
    mod = garment.modifiers.new("FabricThickness_2mm", "SOLIDIFY")
    mod.thickness = .002
    mod.offset = 0
    mod.use_even_offset = False
    mod.use_quality_normals = True
    mod.thickness_clamp = 1
    mod.material_offset = 1
    mod.material_offset_rim = 1
    return mod


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=int, default=288, help="Maximum settle frames; at least 73")
    parser.add_argument("--slug", default="shirt3")
    parser.add_argument("--experiment", help="Write isolated trial outputs under assets-src/experiments/NAME")
    parser.add_argument("--profile", choices=["baseline", "sewn", "gravity"], default="gravity")
    parser.add_argument("--bend", type=float, default=1.5, help="Explicit bending parameter for an isolated comparison")
    parser.add_argument("--sleeve-support", type=float, default=.6, help="Gravity profile: sleeve goal as a fraction of the body's")
    parser.add_argument("--collar-support", type=float, default=.9, help="Gravity profile: rest-shape goal on the ribbed collar")
    parser.add_argument("--mass", type=float, default=.035, help="Gravity profile: solver vertex mass (visual tuning, not g/m²)")
    parser.add_argument("--drape-support", type=float, default=.15, help="Soft body rest-shape support for broad, smooth cloth folds")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.frames < 73:
        parser.error("At least 72 frames (3 s) of warmup are required")
    started = time.perf_counter()
    if args.experiment:
        if Path(args.experiment).name != args.experiment:
            parser.error("experiment must be a single directory name")
        global MODELS, SOURCES, REPORTS
        experiment = ROOT / "assets-src" / "experiments" / args.experiment
        MODELS, SOURCES, REPORTS = experiment / "models", experiment / "blender", experiment / "reports"
        for directory in (MODELS, SOURCES, REPORTS):
            directory.mkdir(parents=True, exist_ok=True)
    reset()
    measurements = ROOT / "assets-src" / "photos" / f"{args.slug}-measurements.json"
    dimensions = DEFAULTS.copy()
    if measurements.exists():
        dimensions.update(json.loads(measurements.read_text(encoding="utf-8")))
    pivot = empty("HookPivot")
    build_hanger(pivot)
    garment, layout = build_patterns(dimensions, pivot, args.profile, args.drape_support, args.collar_support, args.sleeve_support)
    if args.bend is not None:
        garment["bending_override"] = args.bend
    if args.mass is not None:
        garment["mass_override"] = args.mass
    expected_initial = np.array([v.co[:] for v in garment.data.vertices])
    actual_initial = evaluated_vertices(garment)
    assert np.allclose(expected_initial, actual_initial, atol=1e-6), "An active shape key changed the intended starting assembly"
    if measurements.exists():
        layout["dimensions_source"] = "measured"
        save_json(MODELS / "tee_uv_layout.json", layout)
    bpy.context.scene.frame_end = args.frames
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / "tee_patterns.blend"))
    cloth = cloth_settings(garment, args.frames)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / "tee_simulation.blend"))
    previous, stable_frames, speed = None, 0, 0.
    for frame in range(1, args.frames + 1):
        bpy.context.scene.frame_set(frame)
        points = evaluated_vertices(garment)
        speed = float(np.max(np.linalg.norm(points - previous, axis=1)) * 24) if previous is not None else 0.
        if frame % 8 == 1 or frame == args.frames:
            print(f"DRAPE frame={frame}/{args.frames} max_speed={speed:.5f} elapsed={time.perf_counter()-started:.1f}s", flush=True)
        previous = points.copy()
        stable_frames = stable_frames + 1 if speed < .015 else 0
        if frame >= 73 and stable_frames >= 12:
            break
    assert np.isfinite(points).all(), "Cloth produced non-finite positions"
    solver_mass = cloth.settings.mass
    garment.modifiers.remove(cloth)
    shell_report = None
    if args.profile == "gravity":
        from shells import ShellProbe
        probe = ShellProbe(garment, solidify)
        raw = points
        points, _, iterations, left = probe.resolve(points)
        probe.remove()
        assert left == 0, f"{left} solidified shell crossings remain after relaxing creases"
        shell_report = {"relax_iterations": iterations,
                        "max_vertex_shift_m": float(np.linalg.norm(points - raw, axis=1).max()),
                        "vertices_moved": int((np.linalg.norm(points - raw, axis=1) > 1e-6).sum())}
    np.savez_compressed(SOURCES / "tee_drape.npz", positions=points)
    if garment.data.shape_keys:
        garment.shape_key_clear()
    garment.data.vertices.foreach_set("co", points.ravel())
    garment.data.update()
    bpy.context.scene.frame_set(1)
    solidify(garment)
    # Preserve pre-Solidify source for re-simulation and deterministic clip baking.
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / "tee_drape.blend"))
    select_only([garment])
    bpy.ops.object.modifier_apply(modifier="FabricThickness_2mm")
    export_glb(MODELS / "tee.glb", descendants(pivot))
    report_dir = REPORTS / "tee"
    camera = studio()
    for name, angle in (("front", 0), ("back", math.pi), ("left", -math.pi / 2),
                        ("right", math.pi / 2), ("front-three-quarter", -.65), ("back-three-quarter", math.pi - .65)):
        render(report_dir / f"{name}.png", camera, angle)
    save_json(report_dir / "drape-report.json", {
        "blender_version": bpy.app.version_string, "dimensions": dimensions,
        "single_layer_vertices": len(points), "garment": stats(garment),
        "pre_roll_frames": frame - 1, "pre_roll_seconds": (frame - 1) / 24,
        "last_frame_max_velocity_m_s": speed,
        "seam_method": garment["seam_method"], "welded_seam_references": garment["welded_seam_references"],
        "topology_changes_after_simulation": "Only required fixed-topology Solidify 0.002 m; no remesh/subdivision/decimation",
        "crease_relaxation": shell_report,
        "cloth_settings": {"profile": args.profile, "vertex_mass_kg": solver_mass, "drape_support": args.drape_support, "target_fabric": "Medium cotton jersey, 180-220 g/m² visual target", "physically_calibrated": False, "self_collision": True},
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "known_issues": ["Small pinned shoulder support patches stabilize contact; garment is not held purely by friction", "Material parameters are an artist-tuned medium cotton approximation, not a measured fabric calibration"],
    })


if __name__ == "__main__":
    main()
