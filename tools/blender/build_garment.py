"""Sew, drape and export a garment kind other than the tee (docs/garment-kinds.md).

Same method as build_tee.py's gravity profile (docs/cloth-motion.md §2.1):
  1. Parametric pattern pieces at final resolution, welded where their seams share
     vertices, laid out in a hung start pose that just clears the hanger.
  2. Only the cloth the hanger actually holds is pinned (shoulder seam on the wooden
     hanger, waistband in the clips); everything else gets a weak grooming goal.
  3. Gravity drape with Blender Cloth, crease relaxation of the 2 mm shells (shells.py),
     fixed-topology Solidify, export.

Kinds: longsleeve, hoodie, shell (tops on the wooden hanger); skirt, pants (clip hanger).
Writes public/models/<kind>.glb, public/models/<kind>_uv_layout.json,
assets-src/blender/<kind>_*.blend and assets-src/reports/<kind>/.
"""
import argparse
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
from build_hanger import build as build_hanger
from build_tee import PatternAssembly, cloth_settings, evaluated_vertices, solidify
import numpy as np
from mathutils.bvhtree import BVHTree

# Flat measurements (m). Tops: like the tee, plus sleeve angle from vertical and an
# optional hood. Bottoms: waist and hem widths laid flat, pants add rise and leg widths.
KINDS = {
    "longsleeve": dict(family="top", length_m=.72, chest_flat_m=.56, hem_flat_m=.55, armhole_m=.25,
                       sleeve_m=.62, sleeve_opening_m=.17, sleeve_angle=6, rib_width_m=.02, hood=None,
                       mass=.035, bend=1.5, drape_support=.15, sleeve_support=2.2),
    "hoodie": dict(family="top", length_m=.72, chest_flat_m=.60, hem_flat_m=.56, armhole_m=.27,
                   sleeve_m=.62, sleeve_opening_m=.18, sleeve_angle=6, rib_width_m=.02,
                   hood=dict(length_m=.34, half_width_m=.16, thickness_m=.011),
                   mass=.05, bend=3.0, drape_support=.15, sleeve_support=2.2),
    "shell": dict(family="top", length_m=.80, chest_flat_m=.64, hem_flat_m=.62, armhole_m=.29,
                  sleeve_m=.66, sleeve_opening_m=.21, sleeve_angle=7, rib_width_m=.02,
                  hood=dict(length_m=.36, half_width_m=.17, thickness_m=.013),
                  mass=.03, bend=4.0, drape_support=.18, sleeve_support=2.2),
    "skirt": dict(family="bottom", length_m=.46, waist_flat_m=.37, hem_flat_m=.52, band_m=.04,
                  mass=.045, bend=3.0, drape_support=.18),
    "pants": dict(family="bottom", length_m=1.02, waist_flat_m=.39, hip_flat_m=.52, rise_m=.29,
                  leg_hem_flat_m=.20, band_m=.04, mass=.05, bend=3.5, drape_support=.18),
}

ROW = .019          # target row spacing (m), as the tee
WAIST_Z = -.098     # top of the waistband, inside the clip jaws (build_hanger clip style)
CLIP_X = (.135, .165)


def smoothstep(x):
    x = max(0., min(1., x))
    return x * x * (3 - 2 * x)


class Layout:
    """UV islands at one isotropic density; rects are fractions of the 0..1 square."""

    def __init__(self, density):
        self.density = density
        self.islands = []

    def island(self, name, rect, size):
        self.islands.append({"name": name, "rect": rect, "physical_size_m": size})


def faces_from_grid(pattern, grid, uv_of, part, flip):
    for k in range(len(grid) - 1):
        for j in range(len(grid[k]) - 1):
            cell = [(k, j), (k + 1, j), (k + 1, j + 1), (k, j + 1)]
            indices = [grid[a][b] for a, b in cell]
            uvs = [uv_of(a, b) for a, b in cell]
            if flip:
                indices.reverse()
                uvs.reverse()
            pattern.face(indices, uvs, part)


# ---- tops -------------------------------------------------------------------------------

def build_top(spec, pattern):
    """Front/back body as in build_tee (gravity profile), long sleeves, and a collar or hood."""
    columns, neck_start, neck_end = 44, 12, 32
    rows = round(spec["length_m"] / ROW)
    row_h = spec["length_m"] / rows
    arm_rows = round(spec["armhole_m"] / row_h)
    half = spec["chest_flat_m"] / 2
    hps, hem = -.084, -.084 - spec["length_m"]
    neck = .105
    on_wood = lambda a: -.082 - .050 * (a / .22) ** 1.28 + .007 + .008

    # UV: bodies across the top, two sleeves and the collar/hood below.
    sleeve_ring = 2 * spec["armhole_m"] + .06
    hood = spec["hood"]
    neck_ring = 2 * math.pi * neck * .8
    density = min(.48 / spec["chest_flat_m"], .54 / spec["length_m"], .40 / spec["sleeve_m"], .31 / sleeve_ring,
                  .31 / (neck_ring + .1), .40 / (2 * hood["length_m"]) if hood else 1.)
    layout = Layout(density)

    def paper_x(j):
        if j < neck_start:
            return -half + (half - neck) * j / neck_start
        if j <= neck_end:
            return -neck + 2 * neck * (j - neck_start) / (neck_end - neck_start)
        return neck + (half - neck) * (j - neck_end) / (columns - neck_end)

    body = {}
    for side, sign, u0 in (("front", -1, 0.), ("back", 1, .52)):
        grid = []
        for k in range(rows + 1):
            t = k / rows
            row = []
            for j in range(columns + 1):
                x0 = paper_x(j)
                if neck_start <= j <= neck_end:
                    a = max(0., 1 - (x0 / neck) ** 2) ** .5
                    top = hps - (.080 if side == "front" else .025) * a
                    y_top = sign * .03 * a
                else:
                    ax = abs(x0)
                    blend = 1 - (min(ax, .21) - neck) / (.21 - neck)
                    top = on_wood(min(ax, .21)) + (hps - on_wood(neck)) * blend - .9 * max(0., ax - .24)
                    y_top = 0.
                z = top * (1 - t) + hem * t
                cross = max(0., 1 - (x0 / half) ** 2) ** .5
                arm = .038 * math.sin(math.pi * k / arm_rows) if k <= arm_rows else 0.
                y_bulk = sign * (.018 * cross ** .5 + arm * .5 * (1 - cross))
                over_bar = max(0., min(1., (.25 - abs(x0)) / .03))
                y_bulk += sign * .014 * max(0., 1 - t / .08) * over_bar
                if hood and side == "back":
                    # The hood lies on the back: keep the panel a little forward under it.
                    y_bulk -= sign * .004 * max(0., 1 - t / .45) * cross
                top_blend = math.sqrt(max(0., 1 - (1 - min(t / .12, 1)) ** 2))
                y = y_top * (1 - top_blend) + y_bulk * top_blend
                if j in (0, columns):
                    y = sign * arm
                if 0 < k < rows and 0 < j < columns:
                    y += .0006 * math.sin(x0 * 71 + k * .7) * math.sin(math.pi * t)
                z += .004 * (1 - math.cos(x0 / half * math.pi)) / 2 * t ** 10
                x = x0 * (1 - t * (1 - spec["hem_flat_m"] / spec["chest_flat_m"]))
                row.append(pattern.vertex((x, y, z)))
            grid.append(row)
        body[side] = grid
        mirror = 1 if side == "front" else -1
        faces_from_grid(pattern, grid, lambda k, j, u0=u0, mirror=mirror, grid=grid: (
            u0 + (mirror * paper_x(j) + half) * density, .44 + (pattern.vertices[grid[k][j]][2] - hem) * density),
            side, sign == 1)
        layout.island(side, [u0, .44, u0 + spec["chest_flat_m"] * density, .44 + spec["length_m"] * density],
                      [spec["chest_flat_m"], spec["length_m"]])

    # Sleeves hang down beside the body, a few degrees out, flattened like real sleeves.
    angle = math.radians(spec["sleeve_angle"])
    ring_count = max(12, round(spec["sleeve_m"] / .022))
    for side, col, sign, u0 in (("sleeve_left", 0, -1, .0), ("sleeve_right", columns, 1, .33)):
        boundary = ([body["front"][k][col] for k in range(arm_rows + 1)] +
                    [body["back"][k][col] for k in range(arm_rows - 1, 0, -1)])
        n = len(boundary)
        base = [Vector(pattern.vertices[i]) for i in boundary]
        center = sum(base, Vector()) / n
        axis = Vector((sign * math.sin(angle), 0, -math.cos(angle)))
        cross = Vector((sign * math.cos(angle), 0, math.sin(angle)))
        distances = [0.]
        for i in range(n):
            distances.append(distances[-1] + (base[(i + 1) % n] - base[i]).length)
        a, b = .09, .022
        perimeter = math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))
        scale = 2 * spec["sleeve_opening_m"] / perimeter
        cuff_center = center + axis * spec["sleeve_m"] + cross * .03
        grid = [boundary]
        for r in range(1, ring_count + 1):
            t = r / ring_count
            ring = []
            for i in range(n):
                theta = math.tau * i / n
                cuff = cuff_center + cross * (a * scale * math.cos(theta))
                cuff.y = -b * scale * math.sin(theta) - .012
                point = base[i].lerp(cuff, smoothstep(t) * .35 + t * .65)
                # Keep the sleeve's inner side off the body side seam it hangs against.
                point += cross * .022 * math.sin(math.pi * min(t * 2, 1)) * (1 - max(0., math.cos(theta)))
                if r == ring_count - 1:
                    point += (point - cuff_center).normalized() * .0015
                ring.append(pattern.vertex(tuple(point)))
            grid.append(ring)
        for r in range(ring_count):
            for i in range(n):
                ni = (i + 1) % n
                indices = [grid[r][i], grid[r + 1][i], grid[r + 1][ni], grid[r][ni]]
                uvs = [(u0 + distances[ii] * density, rr / ring_count * spec["sleeve_m"] * density)
                       for rr, ii in ((r, i), (r + 1, i), (r + 1, i + 1), (r, i + 1))]
                if sign == -1:
                    indices.reverse()
                    uvs.reverse()
                pattern.face(indices, uvs, side)
        layout.island(side, [u0, 0., u0 + distances[-1] * density, spec["sleeve_m"] * density], [distances[-1], spec["sleeve_m"]])

    neck_ring_ids = ([body["front"][0][j] for j in range(neck_start, neck_end + 1)] +
                     [body["back"][0][j] for j in range(neck_end - 1, neck_start, -1)])
    n = len(neck_ring_ids)
    base = [Vector(pattern.vertices[i]) for i in neck_ring_ids]
    distances = [0.]
    for i in range(n):
        distances.append(distances[-1] + (base[(i + 1) % n] - base[i]).length)
    rib_ring = neck_ring_ids
    if hood:
        # Hood down: a flat pocket on the back. Its inner layer is sewn to the back half of the
        # neckline, its outer layer ends in the free face opening, and the two meet at the
        # side folds and the crown seam (welded like a tee's side seams).
        # Sewn in from the neck corners: the corners sit on the wood, where a hood root would
        # pile five seams onto the hanger.
        seam = [body["back"][0][j] for j in range(neck_start + 3, neck_end - 2)]
        seam_half = abs(pattern.vertices[seam[0]][0])
        L, W, T = hood["length_m"], hood["half_width_m"], hood["thickness_m"]
        cols = len(seam) - 1
        rows_h = max(12, round(L / .02))
        mid_y = .018 + .014 + .010 + T
        layers = {}
        for layer, side_sign in (("inner", -1), ("outer", 1)):
            grid = [seam] if layer == "inner" else []
            for k in range(0 if layer == "outer" else 1, rows_h + 1):
                t = k / rows_h
                # Rolled off the neckline first (no zero-radius crease at the seam), then down.
                roll = math.sin(math.pi * min(t / .25, 1.))
                width = seam_half + (W - seam_half) * smoothstep(t / .35)
                width *= max(.35, math.sqrt(max(0., 1 - max(0., (t - .62) / .42) ** 2)))
                row = []
                for j in range(cols + 1):
                    u = -1 + 2 * j / cols
                    cross = max(0., 1 - u * u) ** .5
                    edge = j in (0, cols) or k == rows_h
                    y = mid_y + (0 if edge else side_sign * T * cross ** .6 * min(1., (1 - t) / .1 + .2))
                    # The top stands up behind the neck (seen over the shoulders from the front).
                    z = hps - .02 - .9 * L * t + .05 * roll + (.016 if layer == "outer" else 0.) * (1 - t)
                    target = Vector((u * width, y + .004 * roll, z))
                    if layer == "inner":
                        p0 = Vector(pattern.vertices[seam[j]])
                        target = p0.lerp(target, smoothstep(t / .3))
                    row.append(pattern.vertex(tuple(target)))
                grid.append(row)
            layers[layer] = grid
        for layer, u0 in (("inner", .67), ("outer", .83)):
            grid = layers[layer]
            faces_from_grid(pattern, grid, lambda k, j, g=grid, u0=u0: (u0 + (pattern.vertices[g[k][j]][0] + W) * density * .5,
                                                                        (pattern.vertices[g[k][j]][2] - (hps - L)) * density),
                            "hood", layer == "outer")
        layout.island("hood", [.67, 0., 1., L * density + .05], [2 * W, L])
        # A short rib finishes the front half of the neckline (the hood covers the back).
        rib_ring = [body["front"][0][j] for j in range(neck_start, neck_end + 1)]
    rib_steps = 4 if not hood else 3
    grid = [rib_ring]
    for r in range(1, rib_steps + 1):
        ring = []
        for vi in rib_ring:
            point = Vector(pattern.vertices[vi])
            depth = .080 if point.y < 0 else .025
            inward = Vector((-point.x / neck ** 2, 0, (hps - point.z) / depth ** 2)).normalized()
            point += inward * (spec["rib_width_m"] * r / rib_steps)
            ring.append(pattern.vertex(tuple(point)))
        grid.append(ring)
    closed = not hood
    count = len(rib_ring)
    rib_v0 = .42 if hood else 0.
    for r in range(rib_steps):
        for i in range(count if closed else count - 1):
            ni = (i + 1) % count
            pattern.face([grid[r][i], grid[r][ni], grid[r + 1][ni], grid[r + 1][i]],
                         [(.67 + distances[ii] * density * (0.5 if hood else 1), rib_v0 + rr / rib_steps * spec["rib_width_m"] * density)
                          for rr, ii in ((r, i), (r, i + 1), (r + 1, i + 1), (r + 1, i))], "collar_rib")
    layout.island("collar_rib", [.67, rib_v0, .67 + distances[-1] * density, rib_v0 + spec["rib_width_m"] * density],
                  [distances[-1], spec["rib_width_m"]])
    return layout


def pin_top(garment, pattern, spec):
    """As build_tee gravity: shoulder seam on the wood is held, the rest is weakly groomed."""
    pin = garment.vertex_groups.new(name="HangerSupport")
    parts_of = {}
    for face, part in zip(pattern.faces, pattern.face_parts):
        for i in face:
            parts_of.setdefault(i, set()).add(part)
    sleeve_only = {i for i, parts in parts_of.items() if parts <= {"sleeve_left", "sleeve_right"}}
    hood_only = {i for i, parts in parts_of.items() if parts == {"hood"}}
    hang = spec["length_m"] * .85
    for v in garment.data.vertices:
        x, y, z = v.co
        hanger_top = -.082 - .050 * (abs(x) / .22) ** 1.28 + .007
        # A hood hangs its weight on the neck corners: hold the seam right up to them.
        if abs(y) < 1e-6 and .115 <= abs(x) <= .215 and z > hanger_top - .012:
            v.co.z = hanger_top + .008
            pin.add([v.index], 1., "REPLACE")
            continue
        fall = max(0., min(1., (-z - .10) / hang))
        weight = spec["drape_support"] * (1 - .7 * fall)
        if v.index in sleeve_only:
            weight *= spec["sleeve_support"]
        if v.index in hood_only:
            # The hood's root (seam allowance, rolled edge) holds its shape; the rest drapes.
            root = max(0., min(1., (z - (-.084 - .02 - .3 * spec["hood"]["length_m"])) / .06))
            weight = spec["drape_support"] * (.25 + 3.5 * root)
        pin.add([v.index], weight, "REPLACE")
    rib = {i for i, parts in parts_of.items() if "collar_rib" in parts}
    for index in rib:
        pin.add([index], .9, "REPLACE")
    return pin, parts_of


# ---- bottoms ----------------------------------------------------------------------------

def build_bottom(spec, kind, pattern):
    """Front and back panels welded at the side seams (and inside legs), waistband on top."""
    columns = 40
    rows = round(spec["length_m"] / ROW)
    waist_half = spec["waist_flat_m"] / 2
    bottom = WAIST_Z - spec["length_m"]
    widest = max(spec.get("hem_flat_m", 0), spec.get("hip_flat_m", 0), spec["waist_flat_m"])
    density = min(.48 / widest, .98 / spec["length_m"])
    layout = Layout(density)
    band_rows = max(2, round(spec["band_m"] / ROW))

    def depth(t, cross, sign):
        # Clamped flat in the clips, opening up below the band (A-line / seat / legs).
        open_up = smoothstep((t * spec["length_m"] - spec["band_m"]) / .12)
        return sign * (.0016 + (.04 if kind == "skirt" else .03) * open_up * cross ** .5)

    if kind == "skirt":
        crotch = rows
    else:
        crotch = round(spec["rise_m"] / spec["length_m"] * rows)
    hip_half = spec.get("hip_flat_m", spec["waist_flat_m"]) / 2

    def upper_half_width(t_abs):
        if kind == "skirt":
            return waist_half + (spec["hem_flat_m"] / 2 - waist_half) * (t_abs / spec["length_m"]) ** .9
        return waist_half + (hip_half - waist_half) * smoothstep(t_abs / (spec["rise_m"] * .8))

    panels = {}
    for side, sign in (("front", -1), ("back", 1)):
        grid = []
        for k in range(crotch + 1):
            t = k / rows
            w = upper_half_width(t * spec["length_m"])
            row = []
            for j in range(columns + 1):
                x = -w + 2 * w * j / columns
                cross = max(0., 1 - (x / w) ** 2) ** .5
                y = depth(t, cross, sign) if 0 < j < columns else 0.
                if kind == "pants" and k == crotch and j == columns // 2:
                    y = 0.  # crotch point: front and back meet
                if kind == "pants" and k > crotch * .6 and 0 < j < columns:
                    # Front/back centre seams curve in toward the crotch.
                    pinch = smoothstep((k - crotch * .6) / (crotch * .4)) * max(0., 1 - abs(x) / .05)
                    y *= 1 - .9 * pinch
                if 0 < k < rows and 0 < j < columns:
                    y += .0005 * math.sin(x * 61 + k * .9)
                row.append(pattern.vertex((x, y, WAIST_Z - t * spec["length_m"])))
            grid.append(row)
        legs = []
        if kind == "pants":
            leg_columns = columns // 2
            for leg, lsign in (("left", -1), ("right", 1)):
                top = grid[crotch][:leg_columns + 1] if lsign < 0 else grid[crotch][leg_columns:]
                leg_grid = [top]
                leg_rows = rows - crotch
                for k in range(1, leg_rows + 1):
                    tl = k / leg_rows
                    t = (crotch + k) / rows
                    half_leg = hip_half / 2 + (spec["leg_hem_flat_m"] / 2 - hip_half / 2) * smoothstep(tl * 1.2)
                    centre = lsign * (hip_half / 2 - .012 * tl)
                    row = []
                    for j in range(leg_columns + 1):
                        x = centre - half_leg + 2 * half_leg * j / leg_columns
                        cross = max(0., 1 - ((x - centre) / half_leg) ** 2) ** .5
                        y = sign * (.0016 + .026 * cross ** .5) if 0 < j < leg_columns else 0.
                        if 0 < k < leg_rows and 0 < j < leg_columns:
                            y += .0005 * math.sin(x * 61 + k * .9)
                        row.append(pattern.vertex((x, y, WAIST_Z - t * spec["length_m"])))
                    leg_grid.append(row)
                legs.append((leg, leg_grid))
        panels[side] = (grid, legs)
        u0 = 0. if side == "front" else .51
        mirror = 1 if side == "front" else -1
        uv = lambda k, j, g: (u0 + (mirror * pattern.vertices[g[k][j]][0] + widest / 2) * density,
                              .01 + (pattern.vertices[g[k][j]][2] - bottom) * density)
        faces_from_grid(pattern, grid, lambda k, j, g=grid: uv(k, j, g), side, sign == 1)
        for leg, leg_grid in legs:
            faces_from_grid(pattern, leg_grid, lambda k, j, g=leg_grid: uv(k, j, g), side, sign == 1)
        layout.island(side, [u0, .01, u0 + widest * density, .01 + spec["length_m"] * density], [widest, spec["length_m"]])
    return layout, band_rows, rows


def pin_bottom(garment, pattern, spec, band_rows):
    """Held only where the clips pinch the waistband; the band itself is stiff."""
    pin = garment.vertex_groups.new(name="HangerSupport")
    band_bottom = WAIST_Z - band_rows * ROW
    hang = spec["length_m"] * .85
    parts_of = {}
    for face, part in zip(pattern.faces, pattern.face_parts):
        for i in face:
            parts_of.setdefault(i, set()).add(part)
    for v in garment.data.vertices:
        x, y, z = v.co
        if z > WAIST_Z - ROW * 1.5 and CLIP_X[0] <= abs(x) <= CLIP_X[1]:
            pin.add([v.index], 1., "REPLACE")
            continue
        if z > band_bottom - 1e-6:
            pin.add([v.index], .85, "REPLACE")
            continue
        fall = max(0., min(1., (WAIST_Z - z) / hang))
        pin.add([v.index], spec["drape_support"] * (1 - .7 * fall), "REPLACE")
    return pin, parts_of


# ---- shared -----------------------------------------------------------------------------

def make_garment(pattern, parent, parts):
    fabric = material("Fabric", (.13, .095, .072), .85)
    inner = material("FabricInner", (.10, .073, .056), .85)
    garment = mesh_object("Garment", pattern.vertices, pattern.faces, fabric, parent)
    garment.data.materials.append(inner)
    uv = garment.data.uv_layers.new(name="UVMap")
    for polygon, coords in zip(garment.data.polygons, pattern.face_uvs):
        for index, coord in zip(polygon.loop_indices, coords):
            uv.data[index].uv = coord
    select_only([garment])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    triangulate = garment.modifiers.new("FixedPatternTriangles", "TRIANGULATE")
    triangulate.quad_method = "FIXED"
    bpy.ops.object.modifier_apply(modifier=triangulate.name)
    garment["pattern_pieces"] = parts
    garment["solver_profile"] = "gravity"
    garment["seam_method"] = f"{len(parts)} pattern pieces joined by matching boundary vertices before simulation"
    garment["welded_seam_references"] = pattern.welded_seam_references
    return garment


def seam_stiffness(garment, parts_of, faces):
    """Seams carry a doubled allowance: stiffer along the seam, half as stiff beside it."""
    seam = {i for i, parts in parts_of.items() if len(parts) > 1}
    ring = {i for face in faces if seam & set(face) for i in face} - seam
    stiff = garment.vertex_groups.new(name="SeamStiffness")
    stiff.add(sorted(seam), 1., "REPLACE")
    stiff.add(sorted(ring), .5, "REPLACE")


def clear_hanger(garment):
    """Push any start vertex out of the hanger: a goal must not start inside its collider."""
    wood = bpy.data.objects["HangerWood"].data
    tree = BVHTree.FromPolygons([v.co for v in wood.vertices], [list(p.vertices) for p in wood.polygons])
    moved = 0
    for vertex in garment.data.vertices:
        surface, normal, _, distance = tree.find_nearest(vertex.co)
        if distance is None or distance > .012:
            continue
        if (vertex.co - surface).dot(normal) < .0035:
            vertex.co = surface + normal * .0035
            moved += 1
    return moved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", required=True, choices=sorted(KINDS))
    parser.add_argument("--frames", type=int, default=288)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    spec = KINDS[args.kind]
    started = time.perf_counter()
    reset()
    pivot = empty("HookPivot")
    build_hanger(pivot, style="wood" if spec["family"] == "top" else "clip")
    pattern = PatternAssembly()
    if spec["family"] == "top":
        layout = build_top(spec, pattern)
        parts = sorted(set(pattern.face_parts))
        garment = make_garment(pattern, pivot, parts)
        _, parts_of = pin_top(garment, pattern, spec)
        bottom_z = -.084 - spec["length_m"]
    else:
        layout, band_rows, _ = build_bottom(spec, args.kind, pattern)
        parts = sorted(set(pattern.face_parts))
        garment = make_garment(pattern, pivot, parts)
        _, parts_of = pin_bottom(garment, pattern, spec, band_rows)
        bottom_z = WAIST_Z - spec["length_m"]
    seam_stiffness(garment, parts_of, pattern.faces)
    moved = clear_hanger(garment)
    garment["kind"] = args.kind
    garment["length_m"] = -bottom_z
    garment["mass_override"] = spec["mass"]
    garment["bending_override"] = spec["bend"]
    save_json(MODELS / f"{args.kind}_uv_layout.json", {
        "schema_version": 1, "kind": args.kind, "units": "m", "uv_origin": "bottom_left", "texture_size": [2048, 2048],
        "uv_per_meter": layout.density, "dimensions": spec, "islands": layout.islands, "stitch_paths_uv": [],
        "notes": "Islands share one isotropic density; unused margins are intentional."})
    bpy.context.scene.frame_end = args.frames
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / f"{args.kind}_patterns.blend"))
    cloth = cloth_settings(garment, args.frames)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / f"{args.kind}_simulation.blend"))
    previous, stable, speed, frame = None, 0, 0., 0
    for frame in range(1, args.frames + 1):
        bpy.context.scene.frame_set(frame)
        points = evaluated_vertices(garment)
        speed = float(np.max(np.linalg.norm(points - previous, axis=1)) * 24) if previous is not None else 0.
        if frame % 16 == 1 or frame == args.frames:
            print(f"DRAPE {args.kind} frame={frame}/{args.frames} max_speed={speed:.5f} elapsed={time.perf_counter()-started:.1f}s", flush=True)
        previous = points.copy()
        stable = stable + 1 if speed < .015 else 0
        if frame >= 73 and stable >= 12:
            break
    assert np.isfinite(points).all(), "Cloth produced non-finite positions"
    garment.modifiers.remove(cloth)
    from shells import ShellProbe
    # Relaxing creases must also keep cloth out of the hanger (hood roots and waistbands sit on it).
    probe = ShellProbe(garment, solidify, collider=bpy.data.objects["HangerWood"], clearance=.006)
    raw = points
    points, solid, iterations, left = probe.resolve(points, max_iterations=150)
    if left:
        # Say where: which pattern pieces the crossing triangles belong to.
        where = {}
        for a, b in probe.crossing_pairs(solid):
            key = tuple(sorted({"/".join(sorted(parts_of.get(int(v) % probe.count, {"?"}))) for t in (a, b) for v in probe.tris[t][:1]}))
            where[key] = where.get(key, 0) + 1
        np.savez_compressed(SOURCES / f"{args.kind}_drape_failed.npz", positions=points)
        print("CROSSINGS", sorted(where.items(), key=lambda kv: -kv[1])[:8], flush=True)
    probe.remove()
    assert left == 0, f"{left} solidified shell crossings remain after relaxing creases"
    np.savez_compressed(SOURCES / f"{args.kind}_drape.npz", positions=points)
    garment.data.vertices.foreach_set("co", points.ravel())
    garment.data.update()
    bpy.context.scene.frame_set(1)
    solidify(garment)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCES / f"{args.kind}_drape.blend"))
    select_only([garment])
    bpy.ops.object.modifier_apply(modifier="FabricThickness_2mm")
    export_glb(MODELS / f"{args.kind}.glb", descendants(pivot))
    report_dir = REPORTS / args.kind
    target = (0, 0, (bottom_z - .05) / 2)
    camera = studio(target=target, width=max(1.25, -bottom_z * 1.25))
    for name, angle in (("front", 0), ("back", math.pi), ("left", -math.pi / 2), ("front-three-quarter", -.65)):
        render(report_dir / f"{name}.png", camera, angle, target=target)
    extent = points.max(axis=0) - points.min(axis=0)
    save_json(report_dir / "drape-report.json", {
        "blender_version": bpy.app.version_string, "kind": args.kind, "dimensions": spec,
        "single_layer_vertices": len(points), "garment": stats(garment), "pattern_pieces": parts,
        "settle_frames": frame, "last_frame_max_velocity_m_s": speed, "start_vertices_pushed_off_hanger": moved,
        "crease_relaxation": {"iterations": iterations, "max_vertex_shift_m": float(np.linalg.norm(points - raw, axis=1).max())},
        "extent_m": {"width": float(extent[0]), "depth": float(extent[1]), "height": float(extent[2])},
        "elapsed_seconds": round(time.perf_counter() - started, 3),
    })


if __name__ == "__main__":
    main()
