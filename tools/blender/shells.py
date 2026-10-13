"""Keep the 2 mm solidified shells from crossing at tight creases.

Cloth self-collision keeps separate parts of the sheet apart, but a sheet folded
back on itself across a single edge has a crease radius near zero, and the inner
Solidify offset of such a crease crosses itself. This relaxes the single layer
only around triangles whose solidified shells actually cross, iterating until
none do. Topology and vertex order never change.
"""
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree


class ShellProbe:
    """A hidden copy of the garment carrying only the export Solidify."""

    def __init__(self, garment, solidify, collider=None, clearance=.005):
        mesh = garment.data.copy()
        if mesh.shape_keys:
            # Shape keys on the copy would override the coordinates we write.
            probe_obj = bpy.data.objects.new("ShellProbe", mesh)
            bpy.context.collection.objects.link(probe_obj)
            probe_obj.shape_key_clear()
        else:
            probe_obj = bpy.data.objects.new("ShellProbe", mesh)
            bpy.context.collection.objects.link(probe_obj)
        probe_obj.hide_render = True
        solidify(probe_obj)
        self.obj = probe_obj
        # Relaxing ignores the hanger, so every step also pushes points back out of it.
        # The collider (e.g. HangerWood) is expressed in the garment's local space.
        self.tree, self.clearance = None, clearance
        if collider is not None:
            to_garment = garment.matrix_world.inverted() @ collider.matrix_world
            self.tree = BVHTree.FromPolygons([to_garment @ v.co for v in collider.data.vertices],
                                             [list(p.vertices) for p in collider.data.polygons])
        self.count = len(mesh.vertices)
        evaluated = probe_obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        solid = evaluated.to_mesh()
        solid.calc_loop_triangles()
        self.tris = np.array([t.vertices[:] for t in solid.loop_triangles], dtype=np.int64)
        assert len(solid.vertices) == 2 * self.count, "Solidify is expected to duplicate every vertex once"
        evaluated.to_mesh_clear()
        edges = np.array([e.vertices[:] for e in mesh.edges], dtype=np.int64)
        self.neighbors = [[] for _ in range(self.count)]
        for a, b in edges:
            self.neighbors[a].append(b)
            self.neighbors[b].append(a)

    def solidify(self, points):
        self.obj.data.vertices.foreach_set("co", points.astype(np.float32).ravel())
        self.obj.data.update()
        evaluated = self.obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        result = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", result)
        evaluated.to_mesh_clear()
        return result.reshape(-1, 3)

    def evaluated_mesh_copy(self, points):
        """The solidified mesh with UVs and materials, for export."""
        self.solidify(points)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = self.obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph).copy()
        evaluated.to_mesh_clear()
        return mesh

    def push_out(self, points):
        if self.tree is None:
            return points
        for i, co in enumerate(points):
            surface, normal, _, distance = self.tree.find_nearest(co.tolist(), .02)
            if surface is None:
                continue
            offset = co - np.array(surface)
            if offset.dot(np.array(normal)) < self.clearance:
                points[i] = np.array(surface) + np.array(normal) * self.clearance
        return points

    def crossing_pairs(self, solid):
        tree = BVHTree.FromPolygons(solid.tolist(), self.tris.tolist())
        pairs = []
        for a, b in tree.overlap(tree):
            if a < b and not set(self.tris[a]) & set(self.tris[b]):
                pairs.append((a, b))
        return pairs

    def resolve(self, points, max_iterations=60, strength=.5):
        """Return (points, solidified points, iterations, crossings left)."""
        # Cloth that the solver left hugging the wood, plus anything relaxing moves, is
        # kept a clearance away so the solidified inner shell stays out of the hanger.
        points = self.push_out(points.copy())
        moved = set()
        for iteration in range(max_iterations + 1):
            if moved:
                points[list(moved)] = self.push_out(points[list(moved)])
            solid = self.solidify(points)
            pairs = self.crossing_pairs(solid)
            if not pairs or iteration == max_iterations:
                return points, solid, iteration, len(pairs)
            marked = {int(v) % self.count for pair in pairs for t in pair for v in self.tris[t]}
            marked |= {n for v in marked for n in self.neighbors[v]}
            moved |= marked
            for v in marked:
                ring = points[self.neighbors[v]]
                points[v] += strength * (ring.mean(axis=0) - points[v])

    def remove(self):
        mesh = self.obj.data
        bpy.data.objects.remove(self.obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
