// Loads the Blender garments (docs/asset-spec.md), one model per garment kind. Each kind's
// static model comes first so the rail shows real garments quickly; its animated one (66
// cloth morphs) follows and replaces it. Until a kind arrives, or if loading fails, its
// products keep the procedural placeholder tee.

import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { products, type Kind } from '../data/products'

export interface GarmentModel {
  kind: Kind
  /** HookPivot-space garment node (meshes for Fabric and FabricInner). */
  garment: THREE.Object3D
  wood: THREE.Mesh
  hook: THREE.Mesh
  animated: boolean
  /** Highest and lowest point of the cloth below the hook (m, hanger space). */
  top: number
  bottom: number
}

export type GarmentModels = Partial<Record<Kind, GarmentModel>>

const base = import.meta.env.BASE_URL
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

function extract(gltf: GLTF, kind: Kind, animated: boolean): GarmentModel {
  const find = <T extends THREE.Object3D>(name: string) => {
    const node = gltf.scene.getObjectByName(name)
    if (!node) throw new Error(`${name} missing from ${kind} model`)
    return node as T
  }
  const garment = find('Garment')
  const wood = find<THREE.Mesh>('HangerWood')
  const hook = find<THREE.Mesh>('HangerHook')
  // Quantised meshes carry their dequantisation in the node transform; keep it, but make
  // each node's matrix relative to HookPivot so they can be re-parented into the rig.
  gltf.scene.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(garment)
  for (const node of [garment, wood, hook]) {
    node.removeFromParent()
    node.matrixWorld.decompose(node.position, node.quaternion, node.scale)
  }
  return { kind, garment, wood, hook, animated, top: bounds.max.y, bottom: bounds.min.y }
}

/** Kinds in the order they first appear on the rail: the animated files load in this order. */
const kinds = [...new Set(products.map((p) => p.kind))]

export function useGarmentModels() {
  const [models, setModels] = useState<GarmentModels>({})
  useEffect(() => {
    let cancelled = false
    const put = (model: GarmentModel) => {
      if (!cancelled) setModels((current) => (current[model.kind]?.animated && !model.animated ? current : { ...current, [model.kind]: model }))
    }
    // extract() detaches nodes from the loaded scene, so it must run once per file — never
    // inside a state updater, which React may call twice.
    const statics = kinds.map((kind) =>
      loader
        .loadAsync(`${base}models/web/${kind}.glb`)
        .then((gltf) => put(extract(gltf, kind, false)))
        .catch((error) => console.warn(`[HangerClub] ${kind} static garment failed, keeping placeholder`, error)),
    )
    // Animated files are large; fetch them one at a time once every static is in.
    Promise.allSettled(statics).then(async () => {
      for (const kind of kinds) {
        if (cancelled) return
        try {
          put(extract(await loader.loadAsync(`${base}models/web/${kind}_anim.glb`), kind, true))
        } catch (error) {
          console.warn(`[HangerClub] ${kind} animated garment failed, using static`, error)
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  return models
}
