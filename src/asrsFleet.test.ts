import { Fleet, PITCH, LEVEL_H, cellPos, type FleetOpts } from './asrsFleet';

// The same field the page runs: storage rows 1 and 3 in five columns with row 2 and the
// sixth column as aisles, two levels above the station deck, three robots, the elevator
// shaft beyond the aisle column.
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

const makeFleet = () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return new Fleet({ ...OPTS, random: rnd });
};


test('builds stacked storage: bins on every level above the travel deck', () => {
  const f = makeFleet();
  expect(f.storage.length).toBe(5 * 2 * 2); // the aisle column stores nothing
  expect(f.bins.length).toBe(14); // two in every three cells
  const levels = new Set(f.bins.map((b) => b.cell![2]));
  expect([...levels].sort()).toEqual([1, 2]);
  expect(f.robots.every((r) => r.cell[2] === 0)).toBe(true); // parked on the deck
});

test('runs full cycles and uses the elevator to reach the upper levels', () => {
  const f = makeFleet();
  const rode = new Set<number>();
  for (let i = 0; i < 60 * 180; i++) {
    f.step(1 / 60);
    for (const r of f.robots) if (r.phase === 'riding') rode.add(r.id);
  }
  expect(f.done).toBeGreaterThan(3);
  expect(rode.size).toBe(3); // every robot has ridden between levels
  expect(f.robots.every((r) => r.trips > 0)).toBe(true);
});

// The floor jamming is the failure mode that matters: a stand-off, a station
// both robots aim for, a shaft nobody can leave. Any of them shows up as
// throughput collapsing, so hold the whole fleet to a floor across seeds.
test('keeps working whatever the order of requests — no jams', () => {
  for (const s0 of [42, 7, 1234, 99]) {
    let seed = s0;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const f = new Fleet({ ...OPTS, random: rnd });
    let lastDone = 0;
    let stallAt = 0;
    let worstGap = 0;
    for (let i = 0; i < 60 * 180; i++) {
      f.step(1 / 60);
      if (f.done > lastDone) {
        lastDone = f.done;
        stallAt = f.t;
      }
      worstGap = Math.max(worstGap, f.t - stallAt);
    }
    expect(f.done).toBeGreaterThanOrEqual(9); // three minutes of real work — every trip rides the elevator now
    expect(f.robots.every((r) => r.trips >= 2)).toBe(true); // nobody left idle
    expect(f.avgCycle()!).toBeLessThan(34);
    expect(worstGap).toBeLessThan(60); // never a minute with nothing delivered
  }
});

test('two robots never occupy the same square', () => {
  const f = makeFleet();
  for (let i = 0; i < 60 * 240; i++) {
    f.step(1 / 60);
    const occupied = f.robots.map((r) => `${r.cell[0]},${r.cell[1]},${r.cell[2]}`);
    expect(new Set(occupied).size).toBe(occupied.length);
  }
});

test('robots keep their distance in world space too — no visual overlap', () => {
  const f = makeFleet();
  for (let i = 0; i < 60 * 240; i++) {
    f.step(1 / 60);
    for (let a = 0; a < f.robots.length; a++)
      for (let b = a + 1; b < f.robots.length; b++) {
        const ra = f.robots[a];
        const rb = f.robots[b];
        if (Math.abs(ra.pos.y - rb.pos.y) > LEVEL_H * 0.5) continue; // different levels
        const d = Math.hypot(ra.pos.x - rb.pos.x, ra.pos.z - rb.pos.z);
        expect(d).toBeGreaterThan(PITCH * 0.9);
      }
  }
});

test('a bin is never nowhere, and no two bins share a cradle', () => {
  const f = makeFleet();
  for (let i = 0; i < 60 * 180; i++) {
    f.step(1 / 60);
    for (const b of f.bins) {
      if (b.cell === null) expect(b.carriedBy).not.toBeNull();
      if (b.carriedBy === null) expect(b.cell).not.toBeNull();
    }
    const occupied = f.bins.filter((b) => b.cell).map((b) => b.cell!.join(','));
    expect(new Set(occupied).size).toBe(occupied.length);
  }
  expect(f.bins.length).toBe(14);
});

test('the handling order is the real one: spread, lift, lock, travel with the bin held HIGH', () => {
  const f = makeFleet();
  const cellByBin = new Map(f.bins.map((b) => [b.id, b.cell && [...b.cell]]));
  const carrierByBin = new Map<number, number | null>(f.bins.map((b) => [b.id, b.carriedBy]));
  for (let i = 0; i < 60 * 180; i++) {
    f.step(1 / 60);
    for (const r of f.robots) {
      // a loaded machine drives, rides and presents with its deck up and the tabs clamped on the bin —
      // lowering it would drop the bin onto the cradle pads it has to clear
      const loaded = r.binId !== null && f.bin(r.binId)?.cell === null;
      if (
        loaded &&
        (r.phase === 'toStation' ||
          r.phase === 'toShelf' ||
          r.phase === 'toLift' ||
          r.phase === 'waitLift' ||
          r.phase === 'board' ||
          r.phase === 'riding' ||
          r.phase === 'present')
      ) {
        expect(r.lift).toBe(1);
        expect(r.grip).toBeGreaterThan(0.3);
        expect(r.grip).toBeLessThan(0.6);
      }
      expect(r.lift).toBeGreaterThanOrEqual(0);
      expect(r.lift).toBeLessThanOrEqual(1);
      expect(r.grip).toBeGreaterThanOrEqual(0);
      expect(r.grip).toBeLessThanOrEqual(1);
    }
    for (const b of f.bins) {
      const prev = cellByBin.get(b.id) ?? null;
      if (prev && b.cell === null) {
        // the bin left its cradle: only mid-lift, tabs spread, deck at the bin
        const r = f.robots[b.carriedBy!];
        expect(r.phase).toBe('liftUp');
        expect(r.grip).toBe(1);
        expect(r.lift).toBeGreaterThan(0.8);
      }
      if (!prev && b.cell) {
        // the bin landed: its carrier is mid-set-down with the tabs spread clear
        const carrier = carrierByBin.get(b.id);
        expect(carrier).not.toBeNull();
        const r = f.robots[carrier!];
        expect(r.phase).toBe('setDown');
        expect(r.grip).toBe(1);
      }
      cellByBin.set(b.id, b.cell && [...b.cell]);
      carrierByBin.set(b.id, b.carriedBy);
    }
  }
});

test('the elevator serves one robot at a time', () => {
  const f = makeFleet();
  for (let i = 0; i < 60 * 240; i++) {
    f.step(1 / 60);
    expect(f.robots.filter((r) => r.phase === 'riding').length).toBeLessThanOrEqual(1);
  }
});

// The review panel proved the earlier suite was blind to vertical teleports:
// the distance test skipped cross-level pairs and the cell test collapses the
// shaft. This one watches world-space y directly — no robot may ever move
// vertically faster than the carriage can carry it.
test('nothing ever teleports: per-tick motion stays within physical speed', () => {
  const f = makeFleet();
  const dt = 1 / 60;
  const maxV = 0.9 * dt + 1e-6; // cruise speed budget per tick, small epsilon
  const maxY = 0.6 * dt + 1e-6; // the carriage's speed budget per tick
  const prev = f.robots.map((r) => ({ ...r.pos }));
  for (let i = 0; i < 60 * 240; i++) {
    f.step(dt);
    f.robots.forEach((r, j) => {
      expect(Math.abs(r.pos.y - prev[j].y)).toBeLessThanOrEqual(maxY);
      expect(Math.hypot(r.pos.x - prev[j].x, r.pos.z - prev[j].z)).toBeLessThanOrEqual(maxV);
      prev[j] = { ...r.pos };
    });
  }
});

test('the carriage recalls to the boarder before a ride begins', () => {
  const f = makeFleet();
  const dt = 1 / 60;
  let prevElev = f.elevLevel;
  for (let i = 0; i < 60 * 240; i++) {
    f.step(dt);
    // the carriage itself may never jump a level in one tick either
    expect(Math.abs(f.elevLevel - prevElev)).toBeLessThanOrEqual((0.6 * dt) / LEVEL_H + 1e-6);
    prevElev = f.elevLevel;
    for (const r of f.robots) {
      if (r.phase === 'riding') {
        // a rider is always at the carriage's height — it boarded it for real
        expect(Math.abs(r.pos.y - f.elevLevel * LEVEL_H)).toBeLessThan(0.001);
      }
    }
  }
});

test('robots stay inside the building', () => {
  const f = makeFleet();
  for (let i = 0; i < 60 * 120; i++) {
    f.step(1 / 60);
    for (const r of f.robots) {
      expect(r.cell[0]).toBeGreaterThanOrEqual(0);
      expect(r.cell[0]).toBeLessThanOrEqual(OPTS.cols);
      expect(r.cell[1]).toBeGreaterThanOrEqual(-1);
      expect(r.cell[1]).toBeLessThanOrEqual(3);
      expect(r.cell[2]).toBeGreaterThanOrEqual(0);
      expect(r.cell[2]).toBeLessThanOrEqual(OPTS.levels);
    }
  }
});

test('cellPos maps a cell to metres on the right level', () => {
  expect(cellPos([2, 3, 1])).toEqual({ x: 2 * PITCH, y: LEVEL_H, z: 3 * PITCH });
});

test('request() queues a shelved bin and refuses when none are free', () => {
  const f = makeFleet();
  expect(f.request()).toBe(true);
  expect(f.queue.length).toBe(1);
  f.bins.forEach((b) => {
    b.cell = null;
    b.carriedBy = 0;
  });
  expect(f.request()).toBe(false);
});

// A loaded robot's bin rides lifted, far too tall to pass under a stored bin on
// its 88 mm cradle — so with the bin aboard the route never enters a stored cell
// (the aisle row is there for that), while the same trip unloaded cuts straight through.
test('a loaded robot routes round stored bins', () => {
  const f = makeFleet();
  const r = f.robots[0];
  r.cell = [0, 3, 1]; // the far storage row, stored bins along it toward the shaft
  r.pos = cellPos(r.cell);
  const b = f.bins.find((bin) => bin.cell && bin.cell[1] === 3 && bin.cell[2] === 1 && bin.cell[0] > 0)!;
  const stored = new Set(f.bins.filter((x) => x.cell && x !== b).map((x) => x.cell!.join(',')));
  const findPath = (f as unknown as { findPath: Fleet['findPath'] }).findPath.bind(f);
  const through = findPath(r.cell, [3, 3, 1], r.id)!;
  expect(through.some((c) => stored.has(c.join(',')))).toBe(true); // empty: straight along the row
  r.binId = b.id;
  b.carriedBy = r.id;
  b.cell = null; // now on the deck, lifted
  const around = findPath(r.cell, [3, 3, 1], r.id)!;
  expect(around.some((c) => stored.has(c.join(',')))).toBe(false);
  expect(around.length).toBeGreaterThan(through.length);
});

test('a robot boards the carriage from the landing, never floats in the shaft', () => {
  const f = makeFleet();
  for (let i = 0; i < 60 * 240; i++) {
    f.step(1 / 60);
    for (const r of f.robots) {
      const inShaft = r.cell[0] === OPTS.elevator[0] && r.cell[1] === OPTS.elevator[1];
      if (inShaft) {
        // whoever stands in the shaft is on the carriage: it is at their floor, or carrying them
        expect(['board', 'riding', 'toBin', 'toStation', 'toShelf']).toContain(r.phase);
        if (r.phase === 'board') expect(Math.abs(f.elevLevel - r.cell[2])).toBeLessThan(1e-3);
      }
    }
  }
});

test('request(id) fetches exactly that bin, and with autoFeed off nothing else moves', () => {
  const f = new Fleet({ ...OPTS, autoFeed: false });
  for (let i = 0; i < 200; i++) f.step(0.05);
  expect(f.robots.every((r) => r.phase === 'idle')).toBe(true); // 10 s, no requests, no work
  expect(f.request(13)).toBe(true);
  expect(f.request(13)).toBe(false); // already queued
  let presented = false;
  for (let i = 0; i < 4000 && !presented; i++) {
    f.step(0.05);
    presented = f.robots.some((r) => r.phase === 'present' && r.binId === 13);
  }
  expect(presented).toBe(true);
  expect(f.robots.filter((r) => r.binId !== null)).toHaveLength(1);
});

test('with stationHold the bin stays at the station, the robot leaves, and a robot brings it back', () => {
  const f = new Fleet({ ...OPTS, autoFeed: false, stationHold: 5 });
  f.request(13);
  const run = (until: () => boolean, secs = 400) => {
    for (let i = 0; i < secs * 20 && !until(); i++) f.step(0.05);
    return until();
  };
  const bin = () => f.bins.find((b) => b.id === 13)!;
  // delivered: the bin sits on a station cell with nobody carrying it
  expect(run(() => !!bin().cell && f.atStation(bin().cell!))).toBe(true);
  expect(bin().carriedBy).toBe(null);
  // and the robot clears the station square instead of standing under it
  const parkedAt = f.t;
  expect(run(() => f.robots.every((r) => !f.atStation(r.cell)))).toBe(true);
  expect(f.atStation(bin().cell!)).toBe(true); // still waiting for the picker
  // after the hold, a robot takes it back to a storage cell
  expect(run(() => !!bin().cell && !f.atStation(bin().cell!))).toBe(true);
  expect(f.t - parkedAt).toBeGreaterThan(5);
  expect(bin().cell![2]).toBeGreaterThan(0); // back up in the rack
});
