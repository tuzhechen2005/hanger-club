// Loads the Blender garment (docs/asset-spec.md). The static tee comes first so the rail
// can show real garments quickly; the animated one (66 cloth morphs) follows and replaces it.
// Until either arrives, or if loading fails, the scene keeps its procedural placeholder.

import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

export interface GarmentModel {
  /** HookPivot-space garment node (meshes for Fabric and FabricInner). */
  garment: THREE.Object3D
  wood: THREE.Mesh
  hook: THREE.Mesh
  animated: boolean
}

const base = import.meta.env.BASE_URL
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

function extract(gltf: GLTF, animated: boolean): GarmentModel {
  const find = <T extends THREE.Object3D>(name: string) => {
    const node = gltf.scene.getObjectByName(name)
    if (!node) throw new Error(`${name} missing from garment model`)
    return node as T
  }
  const garment = find('Garment')
  const wood = find<THREE.Mesh>('HangerWood')
  const hook = find<THREE.Mesh>('HangerHook')
  // Quantised meshes carry their dequantisation in the node transform; keep it, but make
  // each node's matrix relative to HookPivot so they can be re-parented into the rig.
  gltf.scene.updateMatrixWorld(true)
  for (const node of [garment, wood, hook]) {
    node.removeFromParent()
    node.matrixWorld.decompose(node.position, node.quaternion, node.scale)
  }
  return { garment, wood, hook, animated }
}

export function useGarmentModel() {
  const [model, setModel] = useState<GarmentModel | null>(null)
  useEffect(() => {
    let cancelled = false
    // extract() detaches nodes from the loaded scene, so it must run once per file — never
    // inside a state updater, which React may call twice.
    loader
      .loadAsync(`${base}models/web/tee.glb`)
      .then((gltf) => {
        const loaded = extract(gltf, false)
        if (!cancelled) setModel((current) => current ?? loaded)
      })
      .catch((error) => console.warn('[HangerClub] static garment failed, keeping placeholder', error))
    loader
      .loadAsync(`${base}models/web/tee_anim.glb`)
      .then((gltf) => {
        const loaded = extract(gltf, true)
        if (!cancelled) setModel(loaded)
      })
      .catch((error) => console.warn('[HangerClub] animated garment failed, using static', error))
    return () => {
      cancelled = true
    }
  }, [])
  return model
}
