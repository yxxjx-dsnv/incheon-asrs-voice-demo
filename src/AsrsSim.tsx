import { useEffect, useRef, useState } from 'react';
import {
  loadSystemAsset,
  makeRack,
  makeBin,
  makeElevator,
  makeKiosk,
  makeGround,
  systemMaterials,
  CRADLE_H,
  DECK_REST,
  FLOOR_Y,
} from './asrsScene';
import { loadRobotAsset, makeRobot, liftPose, liftFraction, clampFraction, type Robot } from './asrsRobot';
import { Fleet, PITCH, LEVEL_H, PHASE_LABEL, cellPos, type FleetOpts } from './asrsFleet';
import AsrsVoiceDemo from './AsrsVoiceDemo';



// A working miniature of the Incheon ASRS. The fleet state machine lives in
// asrsFleet.ts (and is unit-tested there); this file is only the picture of it:
// build the world once, then copy fleet state onto meshes every frame.

// the lift fraction at which the deck top reaches a cradled bin's underside
const ATTACH = liftFraction(CRADLE_H - DECK_REST);
const CLAMP = clampFraction();

// A small rack you can read at a glance: bins in rows 1 and 3 with row 2 an aisle between
// them and the last column an aisle joining every row to the landing (loaded robots ride
// their bin high and need a way round stored ones), two storage levels over the station
// deck, the elevator on the end, three robots.
const OPTS: FleetOpts = {
  cols: 6,
  rows: [1, 3],
  levels: 2,
  stations: [
    [1, -1],
    [3, -1],
  ],
  robotStart: [0, 2, 4],
  elevator: [6, 0],
  sideAisle: true,
  fillEvery: 3,
};
const STATION_HOLD = 12; // s a delivered bin waits at the station for the picker

const ELEV_TOP = OPTS.levels * LEVEL_H + 0.45; // the tower's top ring; the hoist drum sits 80 mm above it
const YOKE = 0.44; // the lift module's yoke apex, where the hoist cable takes it, above its deck

type Snapshot = {
  t: number;
  lines: Array<{ id: number; text: string }>;
  queue: number;
  done: number;
  avg: number | null;
  running: boolean;
  speed: number;
  focus: number | null;
  xray: boolean;
};

const fmtT = (t: number) => {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
};

export function AsrsSim() {
  const voice = true;
  const active = true;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const fleetRef = useRef<Fleet | null>(null);
  const runRef = useRef(true);
  const speedRef = useRef(1);
  const focusRef = useRef<number | null>(null);
  const xrayRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let raf = 0;
    const cleanupExtra: (() => void)[] = [];
    let renderer:
      | { dispose: () => void; forceContextLoss: () => void; domElement: HTMLCanvasElement }
      | undefined;
    let controls: { dispose: () => void; target: { set: (x: number, y: number, z: number) => void } } | undefined;

    (async () => {
      try {
        const THREE = await import('three');
        const [{ OrbitControls }, { RoomEnvironment }, asset, sys] = await Promise.all([
          import('three/examples/jsm/controls/OrbitControls.js'),
          import('three/examples/jsm/environments/RoomEnvironment.js'),
          loadRobotAsset(),
          loadSystemAsset(),
        ]);
        const mount = mountRef.current;
        if (!mount || disposed) return;

        const dark = () => document.body.classList.contains('dark-mode');
        const scene = new THREE.Scene();
        const setBg = () => {
          const bg = new THREE.Color(dark() ? 0x121316 : 0xd2d5d9);
          scene.background = bg;
          scene.fog = new THREE.Fog(bg, 12, 30);
        };
        setBg();

        const webgl = new THREE.WebGLRenderer({ antialias: true });
        renderer = webgl;
        webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        webgl.setSize(mount.clientWidth || 640, mount.clientHeight || 460);
        webgl.shadowMap.enabled = true;
        webgl.shadowMap.type = THREE.PCFSoftShadowMap;
        webgl.toneMapping = THREE.ACESFilmicToneMapping;
        webgl.toneMappingExposure = 1.05;
        mount.appendChild(webgl.domElement);
        const onLost = (e: Event) => {
          e.preventDefault();
          setStatus('error');
        };
        webgl.domElement.addEventListener('webglcontextlost', onLost);
        cleanupExtra.push(() => webgl.domElement.removeEventListener('webglcontextlost', onLost));

        const pmrem = new THREE.PMREMGenerator(webgl);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        cleanupExtra.push(() => pmrem.dispose());

        const camera = new THREE.PerspectiveCamera(
          40,
          (mount.clientWidth || 640) / (mount.clientHeight || 460),
          0.01,
          90,
        );

        if (typeof ResizeObserver === 'function') {
          const ro = new ResizeObserver(() => {
            const w = mount.clientWidth;
            const h = mount.clientHeight;
            if (w > 0 && h > 0) {
              webgl.setSize(w, h);
              camera.aspect = w / h;
              camera.updateProjectionMatrix();
            }
          });
          ro.observe(mount);
          cleanupExtra.push(() => ro.disconnect());
        }
        const mo = new MutationObserver(setBg);
        mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        cleanupExtra.push(() => mo.disconnect());

        scene.add(new THREE.HemisphereLight(0xffffff, 0x707070, 0.8));
        const key = new THREE.DirectionalLight(0xffffff, 2.1);
        key.position.set(4, 8, 6);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = key.shadow.camera.bottom = -6;
        key.shadow.camera.right = key.shadow.camera.top = 6;
        key.shadow.bias = -0.0012;
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xdfe6ff, 0.5);
        fill.position.set(-5, 3, -4);
        scene.add(fill);

        // ── the world: the rack from the Blender parts, laid out as the fleet's grid ──
        const world = new THREE.Group();
        world.position.set(-(OPTS.cols - 1) * PITCH * 0.5, 0, -1.15 * PITCH);
        scene.add(world);
        const ground = makeGround(THREE, sys, 30);
        ground.position.y = FLOOR_Y;
        world.add(ground);

        const fleet = new Fleet({
          ...OPTS,
          attachAt: ATTACH,
          clamp: CLAMP,
          autoFeed: !voice,
          stationHold: voice ? STATION_HOLD : undefined,
        });
        fleetRef.current = fleet;

        // tiles on every drivable square (the station row only on the ground deck),
        // cradles round every rack cell, posts from the floor to a hand over the top level
        const tiles: Array<[number, number, number]> = [];
        const cradles: Array<[number, number, number]> = [];
        for (let lv = 0; lv <= OPTS.levels; lv++)
          for (let r = lv === 0 ? -1 : 0; r <= Math.max(...OPTS.rows); r++)
            for (let c = 0; c < OPTS.cols; c++) {
              tiles.push([c, r, lv]);
              if (r >= 0) cradles.push([c, r, lv]);
            }
        // the picking stations get cradles too, so a delivered bin has something to rest on
        for (const [c, r] of OPTS.stations) cradles.push([c, r, 0]);
        for (const m of makeRack(THREE, sys, { tiles, cradles, floorY: FLOOR_Y, topY: OPTS.levels * LEVEL_H + 0.3 }))
          world.add(m);

        const binMeshes = new Map<number, ReturnType<typeof makeBin>>();
        for (const b of fleet.bins) {
          const mesh = makeBin(sys, b.id % 7 === 3);
          world.add(mesh);
          binMeshes.set(b.id, mesh);
        }

        // voice demo: print what each bin holds on the bin itself
        {
          const { CATALOG, binNo } = await import('./AsrsVoiceDemo');
          const box = new THREE.Box3();
          for (const it of CATALOG) {
            const mesh = binMeshes.get(it.bin);
            if (!mesh) continue;
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 128;
            const g = canvas.getContext('2d');
            if (!g) break;
            g.fillStyle = 'rgba(12,14,18,0.86)';
            g.beginPath();
            g.roundRect(0, 0, 512, 128, 26);
            g.fill();
            g.fillStyle = '#ffffff';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.font = 'bold 58px Pretendard, system-ui, sans-serif';
            g.fillText(`${binNo(it.bin)}  ${it.name}`, 256, 68, 468);
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
            const tag = new THREE.Sprite(mat);
            tag.scale.set(0.46, 0.115, 1);
            tag.position.set(0, box.setFromObject(mesh).max.y + 0.07, 0);
            tag.renderOrder = 10;
            mesh.add(tag);
            cleanupExtra.push(() => {
              tex.dispose();
              mat.dispose();
            });
          }
        }

        const views: Robot[] = fleet.robots.map(() => {
          const api = makeRobot(asset);
          world.add(api.group);
          cleanupExtra.push(() => api.dispose());
          return api;
        });

        // the focused robot's planned route, drawn on its deck
        const pathGeo = new THREE.BufferGeometry();
        const pathPos = new Float32Array(128 * 3);
        pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPos, 3));
        const pathLine = new THREE.Line(
          pathGeo,
          new THREE.LineBasicMaterial({ color: 0x2f7bff, transparent: true, opacity: 0.9 }),
        );
        pathLine.frustumCulled = false;
        pathLine.visible = false;
        world.add(pathLine);
        cleanupExtra.push(() => {
          pathGeo.dispose();
          pathLine.material.dispose();
        });

        const elevator = makeElevator(sys);
        elevator.group.position.set(OPTS.elevator[0] * PITCH, 0, OPTS.elevator[1] * PITCH);
        world.add(elevator.group);

        const kiosk = makeKiosk(sys);
        kiosk.position.set(-1.35 * PITCH, FLOOR_Y, -1.05 * PITCH);
        kiosk.rotation.y = Math.PI; // screen toward the rack and its stations
        world.add(kiosk);

        // a soft highlight ring that follows the focused robot
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.3, 0.345, 48),
          new THREE.MeshBasicMaterial({
            color: 0x2f7bff,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.visible = false;
        world.add(ring);
        cleanupExtra.push(() => {
          ring.geometry.dispose();
          (ring.material as { dispose: () => void }).dispose();
        });

        const reduced =
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        runRef.current = !reduced;

        // ── camera: looking at the front of the rack from above, kiosk in view
        // the voice demo is filmed full-screen: sit closer, with the picking stations in frame
        // the voice demo is filmed from the picking side — stations and kiosk nearest the lens
        const home = voice ? new THREE.Vector3(0.2, 2.3, -5.0) : new THREE.Vector3(0.6, 3.3, 6.2);
        const homeTarget = voice ? new THREE.Vector3(0.2, 0.5, -0.4) : new THREE.Vector3(0.2, 0.45, 0.3);
        camera.position.copy(home);
        const orbit = new OrbitControls(camera, webgl.domElement);
        controls = orbit;
        orbit.enableDamping = true;
        orbit.target.copy(homeTarget);
        orbit.minDistance = 0.8;
        orbit.maxDistance = 18;
        orbit.maxPolarAngle = Math.PI / 2 - 0.03;

        // ── per-frame: advance the fleet, copy it onto the meshes ──
        const prevPos = fleet.robots.map((r) => ({ ...r.pos }));
        // x-ray ghosts the warehouse itself, so the robots stay the subject
        const envMats = systemMaterials(sys);
        let lastXray = false;
        const applyXray = (on: boolean) => {
          for (const m of envMats) {
            m.transparent = on;
            m.opacity = on ? 0.16 : 1;
            m.depthWrite = !on;
            m.needsUpdate = true;
          }
          views.forEach((v) => v.setXray(on));
        };
        const sync = (dt: number) => {
          const focus = focusRef.current;
          if (xrayRef.current !== lastXray) {
            lastXray = xrayRef.current;
            applyXray(lastXray);
          }
          fleet.robots.forEach((r, i) => {
            const v = views[i];
            v.group.position.set(r.pos.x, r.pos.y, r.pos.z);
            v.setLift(r.lift);
            v.setGrip(r.grip);
            v.roll(r.pos.x - prevPos[i].x, r.pos.z - prevPos[i].z);
            prevPos[i] = { ...r.pos };
          });
          for (const b of fleet.bins) {
            const mesh = binMeshes.get(b.id);
            if (!mesh) continue;
            if (b.cell) {
              const p = cellPos(b.cell);
              mesh.position.set(p.x, p.y + CRADLE_H, p.z);
            } else if (b.carriedBy !== null) {
              const r = fleet.robots[b.carriedBy];
              const deckTop = DECK_REST + liftPose(r.lift).rise;
              mesh.position.set(r.pos.x, r.pos.y + deckTop, r.pos.z);
            }
          }
          const carY = fleet.elevLevel * LEVEL_H; // the carriage's top face is the deck it serves
          elevator.carriage.position.y = carY;
          const cableLen = Math.max(0.02, ELEV_TOP + 0.08 - (carY + YOKE)); // yoke apex to the drum
          elevator.cable.scale.y = cableLen;
          elevator.cable.position.y = carY + YOKE;

          if (focus !== null) {
            const r = fleet.robots[focus];
            ring.visible = true;
            ring.position.set(r.pos.x, r.pos.y + 0.004, r.pos.z);
            // the planned route, drawn a hand above the level it runs on
            const pts = [{ x: r.pos.x, y: r.pos.y, z: r.pos.z }, ...r.path.map((c) => cellPos(c))];
            const n = Math.min(pts.length, 128);
            for (let i = 0; i < n; i++) {
              pathPos[i * 3] = pts[i].x;
              pathPos[i * 3 + 1] = pts[i].y + 0.03;
              pathPos[i * 3 + 2] = pts[i].z;
            }
            pathGeo.setDrawRange(0, n);
            pathGeo.attributes.position.needsUpdate = true;
            pathLine.visible = n > 1;
            const t = world.position.clone().add(new THREE.Vector3(r.pos.x, r.pos.y + 0.2, r.pos.z));
            orbit.target.lerp(t, Math.min(1, dt * 3));
          } else {
            ring.visible = false;
            pathLine.visible = false;
            // no drift back home: the view stays where the visitor panned it (ctrl+drag)
          }
        };
        sync(0);

        let last = 0;
        let hudAt = 0;
        const animate = (now: number) => {
          raf = requestAnimationFrame(animate);
          if (!last) last = now;
          const dt = Math.min((now - last) / 1000, 0.1);
          last = now;
          if (runRef.current) fleet.step(dt * speedRef.current);
          sync(dt);
          orbit.update();
          webgl.render(scene, camera);
          if (now - hudAt > 180) {
            hudAt = now;
            setSnap({
              t: fleet.t,
              queue: fleet.queue.length,
              done: fleet.done,
              avg: fleet.avgCycle(),
              running: runRef.current,
              speed: speedRef.current,
              focus: focusRef.current,
              xray: xrayRef.current,
              lines: fleet.robots.map((r) => ({
                id: r.id,
                text: `R0${r.id + 1}  ${PHASE_LABEL[r.phase].padEnd(13)} c${r.cell[0]},${
                  r.cell[1]
                } L${r.cell[2]}  deck ${(r.lift * 100).toFixed(0).padStart(3)}%  grip ${(
                  r.grip * 100
                )
                  .toFixed(0)
                  .padStart(3)}%`,
              })),
            });
          }
        };
        raf = requestAnimationFrame(animate);
        setStatus('ready');
      } catch (e) {
        console.error('AsrsSim:', e);
        if (!disposed) setStatus('error');
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const fn of cleanupExtra) fn();
      controls?.dispose();
      fleetRef.current = null;
      if (renderer) {
        renderer.domElement.parentNode?.removeChild(renderer.domElement);
        renderer.forceContextLoss();
        renderer.dispose();
      }
    };
  }, [active]);

  return (
    <figure className="asrs-stage">
      <div
        className="asrs-mount"
        ref={mountRef}
        tabIndex={-1}
        role="application"
        aria-label="인천 ASRS 3D 시뮬레이션: 로봇이 빈을 꺼내 엘리베이터로 층을 옮기고 피킹 스테이션에 내려놓습니다. 드래그로 회전, 스크롤로 확대."
      >
        <span className="model-status" role="status" aria-live="polite">
          {status === 'loading' && '창고를 세우는 중…'}
          {status === 'error' && '이 브라우저에서는 3D를 표시할 수 없습니다.'}
        </span>
        {status === 'ready' && snap && (
          <pre className="asrs-hud" aria-hidden="true">
            {`INCHEON ASRS · LIVE SIM        t ${fmtT(snap.t)}\n`}
            {snap.lines.map((l) => (
              <span key={l.id} className={snap.focus === l.id ? 'asrs-hud-focus' : undefined}>
                {l.text}
                {'\n'}
              </span>
            ))}
            {`queue ${snap.queue} · retrieved ${snap.done} · avg cycle ${
              snap.avg ? snap.avg.toFixed(1) + ' s' : '—'
            }`}
          </pre>
        )}
        {status === 'ready' && <AsrsVoiceDemo fleetRef={fleetRef} />}
      </div>
    </figure>
  );
}
