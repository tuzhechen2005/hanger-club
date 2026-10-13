"""Small glTF GLB reader and exact-topology static derivative writer."""
import copy
import json
import struct
from pathlib import Path


def read(path):
    data = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data)
    if (magic, version, length) != (b"glTF", 2, len(data)):
        raise ValueError("Invalid GLB header")
    document, binary, offset = None, b"", 12
    while offset < len(data):
        size, kind = struct.unpack_from("<I4s", data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b"JSON":
            document = json.loads(chunk)
        elif kind == b"BIN\0":
            binary = chunk
        offset += 8 + size
    return document, binary


def write(path, document, binary):
    document["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    chunks = struct.pack("<I4s", len(encoded), b"JSON") + encoded
    chunks += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    Path(path).write_bytes(struct.pack("<4sII", b"glTF", 2, len(chunks) + 12) + chunks)


def static_derivative(animated_path, static_path):
    document, binary = read(animated_path)
    document = copy.deepcopy(document)
    document.pop("animations", None)
    used_accessors = set()
    for node in document["nodes"]:
        node.pop("weights", None)
    for mesh in document["meshes"]:
        mesh.pop("weights", None)
        mesh.get("extras", {}).pop("targetNames", None)
        for primitive in mesh["primitives"]:
            primitive.pop("targets", None)
            used_accessors.update(primitive["attributes"].values())
            if "indices" in primitive:
                used_accessors.add(primitive["indices"])
    mapping = {old: new for new, old in enumerate(sorted(used_accessors))}
    document["accessors"] = [document["accessors"][old] for old in sorted(used_accessors)]
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"] = {name: mapping[index] for name, index in primitive["attributes"].items()}
            if "indices" in primitive:
                primitive["indices"] = mapping[primitive["indices"]]
    used_views = {accessor["bufferView"] for accessor in document["accessors"] if "bufferView" in accessor}
    used_views.update(image["bufferView"] for image in document.get("images", []) if "bufferView" in image)
    view_mapping = {old: new for new, old in enumerate(sorted(used_views))}
    views, packed = [], bytearray()
    for old in sorted(used_views):
        view = document["bufferViews"][old].copy()
        packed.extend(b"\0" * (-len(packed) % 4))
        start = view.get("byteOffset", 0)
        chunk = binary[start:start + view["byteLength"]]
        view["byteOffset"], view["buffer"] = len(packed), 0
        packed.extend(chunk)
        views.append(view)
    document["bufferViews"] = views
    for accessor in document["accessors"]:
        if "bufferView" in accessor:
            accessor["bufferView"] = view_mapping[accessor["bufferView"]]
    for image in document.get("images", []):
        if "bufferView" in image:
            image["bufferView"] = view_mapping[image["bufferView"]]
    write(static_path, document, bytes(packed))


def accessor(document, binary, index):
    import numpy as np
    info = document["accessors"][index]
    component = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[info["componentType"]]
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[info["type"]]
    if "bufferView" not in info:
        data = np.zeros((info["count"], width), dtype=component)
    else:
        view = document["bufferViews"][info["bufferView"]]
        start = view.get("byteOffset", 0) + info.get("byteOffset", 0)
        stride = view.get("byteStride", np.dtype(component).itemsize * width)
        data = np.ndarray((info["count"], width), dtype=component, buffer=binary,
                          offset=start, strides=(stride, np.dtype(component).itemsize)).copy()
    if "sparse" in info:
        sparse = info["sparse"]
        indices_info = sparse["indices"]
        values_info = sparse["values"]
        view = document["bufferViews"][indices_info["bufferView"]]
        dtype = {5121: "u1", 5123: "<u2", 5125: "<u4"}[indices_info["componentType"]]
        indices = np.frombuffer(binary, dtype=dtype, count=sparse["count"], offset=view.get("byteOffset", 0) + indices_info.get("byteOffset", 0))
        view = document["bufferViews"][values_info["bufferView"]]
        values = np.frombuffer(binary, dtype=component, count=sparse["count"] * width,
                               offset=view.get("byteOffset", 0) + values_info.get("byteOffset", 0)).reshape(-1, width)
        data[indices] = values
    return data
