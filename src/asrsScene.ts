// The ASRS around the robot: parts from asrs-system.glb (built by tools/asrs/build_system.py
// in Blender — posts, feet, cross joints, cradles, deck tiles, Euro bins, the elevator, the
// kiosk, a ground swatch), instanced per cell here. No generated geometry any more.
import type { Group, InstancedMesh, Material, Mesh, Object3D, Texture } from 'three';

import { PITCH, LEVEL_H } from './asrsFleet';

type ThreeNS = typeof import('three');

export const CRADLE_H = 0.088; // cradle pads — a stored bin's underside
export const DECK_REST = 0.0495; // deck top surface, deck down
export const DECK_LIFT = 0.1295; // deck top surface, deck up (41 mm over the cradle pads)
export const WHEEL_R = 0.03;
export const TILE_T = 0.016;
export const FLOOR_Y = -0.22; // the concrete floor under a rack standing on its feet
const GLB = '/media/incheon-robotics/asrs-system.glb';

export type SystemAsset = {
  parts: Record<'Post' | 'Foot' | 'DeckJoint' | 'Cradle' | 'Tile' | 'Bin_Blue' | 'Bin_Black' | 'Ground', Mesh>;
  elevator: Group;
  kiosk: Object3D;
};

let asset: Promise<SystemAsset> | undefined;

async function load(): Promise<SystemAsset> {
  const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
  ]);
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync(GLB);
  const scene = gltf.scene;
  const mesh = (name: string): Mesh => {
    const o = scene.getObjectByName(name);
    if (!o || !(o as Mesh).isMesh) throw new Error(`asrs-system.glb: no mesh ${name}`);
    return o as Mesh;
  };
  const parts = {
    Post: mesh('Post'),
    Foot: mesh('Foot'),
    DeckJoint: mesh('DeckJoint'),
    Cradle: mesh('Cradle'),
    Tile: mesh('Tile'),
    Bin_Blue: mesh('Bin_Blue'),
    Bin_Black: mesh('Bin_Black'),
    Ground: mesh('Ground'),
  };
  for (const m of Object.values(parts)) {
    m.castShadow = m.receiveShadow = true;
  }
  const elevator = scene.getObjectByName('Elevator') as Group;
  const kiosk = scene.getObjectByName('Kiosk');
  if (!elevator || !kiosk) throw new Error('asrs-system.glb: no elevator or kiosk');
  return { parts, elevator, kiosk };
}

export function loadSystemAsset(): Promise<SystemAsset> {
  asset ??= load().catch((e) => {
    asset = undefined;
    throw e;
  });
  return asset;
}

/** The materials the parts share — X-ray ghosts these. */
export function systemMaterials(sys: SystemAsset): Material[] {
  const out = new Set<Material>();
  const take = (o: Object3D) =>
    o.traverse((c) => {
      const m = (c as Mesh).material as Material | Material[] | undefined;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) out.add(x);
    });
  for (const p of Object.values(sys.parts)) take(p);
  take(sys.elevator);
  return [...out];
}

const instances = (THREE: ThreeNS, part: Mesh, n: number): InstancedMesh => {
  const im = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, n));
  im.count = n;
  im.castShadow = im.receiveShadow = true;
  return im;
};

export type RackSpec = {
  tiles: Array<[number, number, number]>; // [col, row, level] cells with a deck tile
  cradles: Array<[number, number, number]>; // cells whose four corners carry cradle crosses
  floorY: number; // where the feet stand
  topY: number; // where the posts end
};

/**
 * Posts on flanged feet at every tile corner, a cross joint under each corner on every
 * level, cradles round the cells that store bins, and the tiles themselves — as five
 * instanced meshes from the GLB parts. Cells are the fleet's (column, row, level).
 */
export function makeRack(THREE: ThreeNS, sys: SystemAsset, spec: RackSpec): InstancedMesh[] {
  const corner = (c: number, r: number) => [
    [c - 0.5, r - 0.5],
    [c + 0.5, r - 0.5],
    [c - 0.5, r + 0.5],
    [c + 0.5, r + 0.5],
  ];
  const posts = new Map<string, [number, number]>();
  const joints = new Map<string, [number, number, number]>();
  const cradles = new Map<string, [number, number, number]>();
  for (const [c, r, lv] of spec.tiles)
    for (const [cx, cz] of corner(c, r)) {
      posts.set(`${cx},${cz}`, [cx, cz]);
      joints.set(`${cx},${cz},${lv}`, [cx, cz, lv]);
    }
  for (const [c, r, lv] of spec.cradles) for (const [cx, cz] of corner(c, r)) cradles.set(`${cx},${cz},${lv}`, [cx, cz, lv]);

  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const q = new THREE.Quaternion();
  const tiles = instances(THREE, sys.parts.Tile, spec.tiles.length);
  spec.tiles.forEach(([c, r, lv], i) => {
    m.makeTranslation(c * PITCH, lv * LEVEL_H, r * PITCH);
    tiles.setMatrixAt(i, m);
  });
  const postMesh = instances(THREE, sys.parts.Post, posts.size);
  const feet = instances(THREE, sys.parts.Foot, posts.size);
  [...posts.values()].forEach(([cx, cz], i) => {
    m.compose(new THREE.Vector3(cx * PITCH, spec.floorY, cz * PITCH), q, new THREE.Vector3(1, spec.topY - spec.floorY, 1));
    postMesh.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(cx * PITCH, spec.floorY, cz * PITCH), q, one);
    feet.setMatrixAt(i, m);
  });
  const jointMesh = instances(THREE, sys.parts.DeckJoint, joints.size);
  [...joints.values()].forEach(([cx, cz, lv], i) => {
    m.makeTranslation(cx * PITCH, lv * LEVEL_H - TILE_T, cz * PITCH);
    jointMesh.setMatrixAt(i, m);
  });
  const cradleMesh = instances(THREE, sys.parts.Cradle, cradles.size);
  [...cradles.values()].forEach(([cx, cz, lv], i) => {
    m.makeTranslation(cx * PITCH, lv * LEVEL_H, cz * PITCH);
    cradleMesh.setMatrixAt(i, m);
  });
  return [tiles, postMesh, feet, jointMesh, cradleMesh];
}

/** One bin, sharing the GLB geometry and material; its origin is the bottom centre. */
export function makeBin(sys: SystemAsset, black = false): Mesh {
  const src = black ? sys.parts.Bin_Black : sys.parts.Bin_Blue;
  const mesh = src.clone();
  mesh.position.set(0, 0, 0);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/** The elevator tower with its carriage (top face at y = level) and a unit cable to scale. */
export function makeElevator(sys: SystemAsset): { group: Group; carriage: Object3D; cable: Object3D } {
  const group = sys.elevator.clone(true);
  group.traverse((o) => {
    o.castShadow = o.receiveShadow = true;
  });
  const carriage = group.getObjectByName('Carriage');
  const cable = group.getObjectByName('Cable');
  if (!carriage || !cable) throw new Error('asrs-system.glb: elevator without carriage or cable');
  return { group, carriage, cable };
}

export function makeKiosk(sys: SystemAsset): Object3D {
  const k = sys.kiosk.clone(true);
  k.traverse((o) => {
    o.castShadow = true;
  });
  return k;
}

/** The concrete floor: a big plane wearing the GLB's ground material, tiled at 2 m. */
export function makeGround(THREE: ThreeNS, sys: SystemAsset, size: number): Mesh {
  const mat = sys.parts.Ground.material as Material & { map?: Texture | null };
  if (mat.map) {
    mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
    mat.map.repeat.set(size / 2, size / 2);
    mat.map.needsUpdate = true;
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  return floor;
}
