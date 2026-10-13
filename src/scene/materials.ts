import * as THREE from 'three'
import type { PrintPlacement, Product } from '../data/products'
import { UV_LAYOUT } from './geometry'

export interface ClothUniforms {
  uBend: { value: THREE.Vector2 }
  uFlare: { value: number }
  uTwist: { value: number }
  uLength: { value: number }
}

/**
 * Fabric material with cheap secondary motion in the vertex shader: the hem lags behind
 * swings and spins, weighted by depth below the hook. Not cloth simulation.
 * Back faces (the inside of the garment) are darkened.
 */
export function createClothMaterial(texture: THREE.Texture, fabric: string) {
  const sheen = new THREE.Color(fabric).lerp(new THREE.Color('#ffffff'), 0.35)
  const material = new THREE.MeshPhysicalMaterial({
    map: texture,
    roughness: 0.9,
    sheen: 0.5,
    sheenRoughness: 0.75,
    sheenColor: sheen,
    side: THREE.DoubleSide,
  })
  const uniforms: ClothUniforms = {
    uBend: { value: new THREE.Vector2() },
    uFlare: { value: 0 },
    uTwist: { value: 0 },
    uLength: { value: 0.82 },
  }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec2 uBend;
uniform float uFlare;
uniform float uTwist;
uniform float uLength;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float hang = clamp((-transformed.y - 0.08) / uLength, 0.0, 1.0);
float w = hang * hang;
float tw = uTwist * w;
transformed.xz = mat2(cos(tw), -sin(tw), sin(tw), cos(tw)) * transformed.xz;
transformed.xz += transformed.xz * uFlare * w;
transformed.xz += uBend * w;`,
      )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
if (!gl_FrontFacing) diffuseColor.rgb *= 0.5;`,
    )
  }
  material.customProgramCacheKey = () => 'cloth-v1'
  return { material, uniforms }
}

const SIZE = 1024

let knitTile: HTMLCanvasElement | null = null
function knit() {
  if (knitTile) return knitTile
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const img = g.createImageData(64, 64)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 70
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  knitTile = c
  return c
}

function drawPrint(g: CanvasRenderingContext2D, image: HTMLImageElement, place: PrintPlacement, rect: typeof UV_LAYOUT.front) {
  const x0 = rect.u0 * SIZE
  const w = (rect.u1 - rect.u0) * SIZE
  const h = (rect.v1 - rect.v0) * SIZE
  const top = (1 - rect.v1) * SIZE
  const pw = place.width * w
  // Rect height covers the garment length; widths are body widths. Keep the print's own aspect
  // in physical units (body width ≈ 0.61 m, length ≈ 0.70 m).
  const ph = ((pw / w) * 0.61 * place.aspect * h) / 0.7
  const cx = x0 + w / 2 + place.centerX * w
  const py = top + Math.max(0, place.top - UV_LAYOUT.neckDrop) * h
  g.save()
  g.beginPath()
  g.rect(x0, top, w, h)
  g.clip()
  g.drawImage(image, cx - pw / 2, py, pw, ph)
  g.restore()
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })

/** Placeholder base color texture: fabric color + knit grain + prints from the photos. */
export function createGarmentTexture(product: Product, onUpdate: () => void) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const g = canvas.getContext('2d')!
  g.fillStyle = product.fabric
  g.fillRect(0, 0, SIZE, SIZE)
  g.globalAlpha = 0.07
  g.globalCompositeOperation = 'overlay'
  g.fillStyle = g.createPattern(knit(), 'repeat')!
  g.fillRect(0, 0, SIZE, SIZE)
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4

  const sides = [
    ['front', UV_LAYOUT.front],
    ['back', UV_LAYOUT.back],
  ] as const
  for (const [side, rect] of sides) {
    const place = product.prints[side]
    if (!place) continue
    loadImage(place.url)
      .then((image) => {
        drawPrint(g, image, place, rect)
        texture.needsUpdate = true
        onUpdate()
      })
      .catch(() => {
        // Missing print image: the plain garment still renders.
      })
  }
  return texture
}
