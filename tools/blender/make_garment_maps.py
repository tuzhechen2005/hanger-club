"""Knit/seam normal map for a build_garment.py kind, from its UV layout.

    python tools/blender/make_garment_maps.py --kind hoodie

Writes public/textures/<kind>_normal.png (the tee's comes from make_product_texture.py).
"""
import argparse
import json
from pathlib import Path

from make_product_texture import ROOT, normal_map


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", required=True)
    args = parser.parse_args()
    layout = json.loads((ROOT / "public" / "models" / f"{args.kind}_uv_layout.json").read_text())
    destination = ROOT / "public" / "textures" / f"{args.kind}_normal.png"
    destination.parent.mkdir(parents=True, exist_ok=True)
    normal_map(layout, destination)
    print(destination.relative_to(ROOT))


if __name__ == "__main__":
    main()
