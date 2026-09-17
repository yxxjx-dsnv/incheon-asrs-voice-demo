// The ASRS robot: a Blender-built GLB (tools/robot/build_robot.py) driven by
// the kinematics below. dims.json is the single source of truth shared with
// the build script — frame there is Blender Z-up; here three.js Y-up, so
// Blender +Y is three.js −Z.
//
// The GLB is loaded and parsed once per page; every robot is a clone of that
// scene, sharing geometry and cloning only the six "shell" materials so
// X-ray can ghost one robot at a time.

import type { Group, Material, Mesh, Object3D } from 'three';
import dims from './dims.json';

type Axis = 'long' | 'short';
type Dir = { x: number; z: number };

const { scissor: S, gripper: G, wheel: W } = dims;
const rad = (deg: number) => (deg * Math.PI) / 180;
const CLOSED = rad(G.hub_angle_closed_deg);
const OPEN = rad(G.hub_angle_open_deg);

// ── kinematics (pure) ──────────────────────────────────────────────────────

/** Deck rise and scissor bar angle for lift fraction t (0 down … 1 up). */
export function liftPose(t: number) {
  const rise = dims.deck.stroke * t * t * (3 - 2 * t); // S-curve: starts and stops like a machine
  const theta = Math.asin((S.deck_pivot_z - S.body_pivot_z + rise) / S.bar_length);
  return { rise, theta };
}

/** Inverse of liftPose: the lift fraction at which the deck has risen `rise`. */
export const liftFraction = (rise: number) =>
  0.5 - Math.sin(Math.asin(1 - (2 * rise) / dims.deck.stroke) / 3);

/** Crank-slider: distance from the hub axis to a tab's slot pin at hub angle α. */
const slider = (axis: Axis, a: number) => {
  const { crank_r: r, link_l: l } = G[axis];
  return r * Math.cos(a) + Math.sqrt(l * l - r * r * Math.sin(a) ** 2);
};

/** Hub angle and how far each tab pair has run out for grip fraction t (0 closed … 1 open). */
/** The bin the site handles (asrs-system.glb): 600 × 400 Euro bin, 556 × 376 at the bottom. */
export const BIN_HALF = { long: 0.556 / 2 + 0.002, short: 0.376 / 2 + 0.002 };

/**
 * Locking means the tabs close in until they meet the bin's sides — not all the way, which
 * would put them through it. One hub drives both pairs, so it stops at the first contact.
 */
export function clampFraction(half = BIN_HALF): number {
  const need = (axis: Axis) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (G[axis].tip + gripPose(mid).slide[axis] < half[axis]) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  return Math.max(need('long'), need('short'));
}

export function gripPose(t: number) {
  const hubAngle = CLOSED + t * (OPEN - CLOSED);
  return {
    hubAngle,
    slide: {
      long: slider('long', hubAngle) - slider('long', CLOSED),
      short: slider('short', hubAngle) - slider('short', CLOSED),
    },
  };
}

/** Mecanum wheel spin (radians) for a world move; sign is the roller handedness. */
export const wheelTurn = (dx: number, dz: number, sign: number) => (dx + sign * dz) / W.radius;

/** Hub-pin offset in three.js XZ for a tab whose outward unit vector is u —
 *  Blender's CCW-about-Z convention after the Y-up conversion. */
export function crankPin(axis: Axis, a: number, u: Dir): Dir {
  const r = G[axis].crank_r;
  const v = { x: u.z, z: -u.x };
  return { x: r * (Math.cos(a) * u.x + Math.sin(a) * v.x), z: r * (Math.cos(a) * u.z + Math.sin(a) * v.z) };
}

// ── the asset ──────────────────────────────────────────────────────────────

export type RobotAsset = { scene: Group };

let asset: Promise<RobotAsset> | undefined;

/** Fetch and parse robot.glb once per page. */
export function loadRobotAsset(): Promise<RobotAsset> {
  asset ??= load().catch((e) => {
    asset = undefined; // a failed fetch must not poison every later viewer
    throw e;
  });
  return asset;
}

async function load(): Promise<RobotAsset> {
  const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
  ]);
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  const { scene } = await loader.loadAsync('/media/incheon-robotics/robot.glb');
  draco.dispose();
  return { scene };
}

// ── the robot ──────────────────────────────────────────────────────────────

export type Robot = {
  group: Group;
  setLift: (t: number) => void;
  setGrip: (t: number) => void;
  /** Per-wheel mecanum spin from a world-space move (dx, dz metres). */
  roll: (dx: number, dz: number) => void;
  /** Ghost the shell to show the working parts, like the CAD x-ray renders. */
  setXray: (on: boolean) => void;
  dispose: () => void;
};

// tab outward directions in three.js (Blender +Y = three.js −Z)
export const TABS = [
  { name: 'XP', axis: 'long', u: { x: 1, z: 0 } },
  { name: 'XN', axis: 'long', u: { x: -1, z: 0 } },
  { name: 'YP', axis: 'short', u: { x: 0, z: -1 } },
  { name: 'YN', axis: 'short', u: { x: 0, z: 1 } },
] as const;

// wheel quadrants in three.js; roller handedness follows: FL & RR one way,
// FR & RL the mirror (sign = −sx·sz)
export const WHEELS = [
  { name: 'FL', sx: 1, sz: -1 },
  { name: 'FR', sx: 1, sz: 1 },
  { name: 'RL', sx: -1, sz: -1 },
  { name: 'RR', sx: -1, sz: 1 },
] as const;

/** One robot: a clone of the loaded scene with its rig nodes wired to the kinematics. */
export function makeRobot({ scene }: RobotAsset): Robot {
  const group = scene.clone(true);
  const isMesh = (o: Object3D): o is Mesh => (o as Mesh).isMesh === true;

  // per-robot clones of the shell materials, so x-ray can ghost this robot only
  const shellMats: Material[] = [];
  group.traverse((o) => {
    if (isMesh(o)) o.castShadow = o.receiveShadow = true;
    if (o.userData.xray !== 'shell') return;
    o.traverse((m) => {
      if (!isMesh(m)) return;
      m.material = (m.material as Material).clone();
      shellMats.push(m.material as Material);
    });
  });

  const node = (name: string) => {
    const o = group.getObjectByName(name);
    if (!o) throw new Error(`robot.glb: missing rig node "${name}"`);
    return o;
  };
  const deck = node('Deck');
  const hub = node('Hub');
  const scissorA = [node('Scissor_A_L'), node('Scissor_A_R')];
  const scissorB = [node('Scissor_B_L'), node('Scissor_B_R')];
  const tabs = TABS.map((t) => {
    const link = node(`Link_${t.name}`);
    return { ...t, tab: node(`Tab_${t.name}`), link, linkY: link.position.y };
  });
  const wheels = WHEELS.map((w) => ({ sign: -w.sx * w.sz, node: node(`Wheel_${w.name}`) }));

  const setLift = (t: number) => {
    const { rise, theta } = liftPose(t);
    deck.position.y = rise;
    for (const s of scissorA) s.rotation.z = theta;
    for (const s of scissorB) s.rotation.z = -theta;
  };

  const setGrip = (t: number) => {
    const { hubAngle, slide } = gripPose(t);
    hub.rotation.y = hubAngle - CLOSED;
    for (const { tab, link, axis, u, linkY } of tabs) {
      const s = slide[axis];
      tab.position.set(u.x * s, 0, u.z * s);
      // the link hangs from its hub pin and points at the tab's slot pin
      const pin = crankPin(axis, hubAngle, u);
      const slot = G[axis].pin_closed + s;
      link.position.set(pin.x, linkY, pin.z);
      link.rotation.y = Math.atan2(-(u.z * slot - pin.z), u.x * slot - pin.x);
    }
  };

  const roll = (dx: number, dz: number) => {
    for (const w of wheels) w.node.rotation.z -= wheelTurn(dx, dz, w.sign);
  };

  const setXray = (on: boolean) => {
    for (const m of shellMats) {
      m.transparent = on;
      m.opacity = on ? 0.16 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
  };

  // geometry and the other materials belong to the cached asset
  const dispose = () => {
    for (const m of shellMats) m.dispose();
  };

  setLift(0);
  setGrip(0);
  return { group, setLift, setGrip, roll, setXray, dispose };
}
