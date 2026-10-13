#!/bin/sh
# Web copies of the Blender exports: meshopt-compressed geometry/morphs, WebP textures.
# Vertex order is preserved (no weld/simplify/join/flatten) so morph targets stay valid.
set -e
cd "$(dirname "$0")/../.."
mkdir -p public/models/web
# Every garment kind that has a baked animated export (tee, longsleeve, hoodie, ...).
for anim in public/models/*_anim.glb; do
  kind=$(basename "$anim" _anim.glb)
  for name in "$kind" "${kind}_anim"; do
  npx gltf-transform optimize "public/models/$name.glb" "public/models/web/$name.glb" \
    --compress meshopt --texture-compress webp --texture-size 2048 \
    --weld false --simplify false --join false --flatten false --instance false \
    --palette false --resample false --prune false
  done
done
ls -la public/models/web
