// The fleet state machine, with no three.js in it.
//
// The renderer reads this every frame and copies state onto meshes; that
// separation is what makes the simulation testable — step() is pure arithmetic
// over plain objects, so a test can run several simulated minutes instantly.
//
// The layout follows the real machine: robots drive across the deck of a
// level, and bins sit on cradles above that deck, so an empty robot can drive
// under any stored bin and fetches one by parking underneath it. A loaded
// robot carries its bin lifted (clear of the cradle pads), which is taller than
// a stored bin's underside, so it routes only through empty cells — the aisle
// rows and unfilled cradles. Routing is A* over the level, around whatever
// squares other robots currently hold. Levels are joined by the elevator: a
// robot waits on the landing beside the shaft until the carriage is at its
// floor, drives onto it, rides, and drives off.

export const PITCH = 0.62; // tile pitch, metres (one 600×400 Euro bin per cell)
export const LEVEL_H = 0.408; // vertical pitch between decks
export const SPEED = 0.85; // m/s, cruise
export const ACCEL = 1.9; // m/s² — the trapezoidal profile's ramp
export const CORNER_V = 0.28; // m/s through a 90° direction change
export const LIFT_TIME = 0.8; // s for full deck travel
export const GRIP_TIME = 0.6; // s for the tabs to run out or back in
export const DWELL = 1.5; // s presenting at the picking station
export const ELEV_SPEED = 0.6; // m/s for the carriage
export const FEED_EVERY = 2.4; // s between auto-generated requests
export const REPLAN_AFTER = 0.5; // s blocked before trying another line
export const YIELD_AFTER = 1.6; // s blocked before stepping aside to break a stand-off

export type Phase =
  | 'idle'
  | 'toBin'
  | 'spread' // tabs run out past the bin's footprint
  | 'liftUp' // deck rises, bin comes off its cradle onto the deck
  | 'lock' // tabs close in until they meet the bin's sides — it is clamped, and stays lifted
  | 'toLift' // heading for the landing beside the elevator shaft
  | 'waitLift' // on the landing: the carriage is recalled to this floor
  | 'holdLift' // stood aside off the landing while another robot has the carriage
  | 'board' // driving onto the carriage
  | 'riding'
  | 'toStation'
  | 'present'
  | 'toShelf'
  | 'unlock' // tabs spread, freeing the bin
  | 'setDown' // deck lowers, the cradle catches the bin
  | 'stow'; // tabs close, machine goes home

/** A grid square: column, row, level. Level 0 is the travel deck. */
export type Cell = [number, number, number];
export type Vec3 = { x: number; y: number; z: number };
export type Bin = { id: number; cell: Cell | null; carriedBy: number | null };

export type FleetRobot = {
  id: number;
  cell: Cell;
  pos: Vec3;
  path: Cell[];
  phase: Phase;
  after: Phase; // what to do once the current drive/ride finishes
  lift: number; // 0 = deck down, 1 = deck up
  grip: number; // 0 = tabs in, 1 = tabs out
  spin: number; // cumulative hub rotation, radians (drives the tabs)
  heading: number; // radians, for the wheels
  binId: number | null;
  target: Cell | null; // where the carried bin is going
  goal: Cell | null; // where this robot is driving
  station: number;
  dwell: number;
  vel: number; // current speed, m/s — ramped, never stepped
  blocked: number; // s spent waiting on another robot
  startedAt: number;
  trips: number;
  returning: boolean; // carrying a bin back from a station to storage
};

export type FleetOpts = {
  attachAt?: number; // lift fraction where the deck meets a cradled bin
  clamp?: number; // grip fraction where the tabs meet the bin's sides (locked)
  cols: number;
  rows: number[]; // storage rows (z, in cells)
  levels: number; // storage levels above the travel deck
  stations: Array<[number, number]>; // picking stations on level 0
  robotStart: number[]; // columns the robots park on (row 0, level 0)
  elevator: [number, number]; // the shaft's column and row
  sideAisle?: boolean; // the last column stores nothing: it joins every aisle row to the landing
  fillEvery: number; // leave every Nth storage cell empty
  autoFeed?: boolean; // false: nothing moves until request() is called (default true)
  stationHold?: number; // s a delivered bin rests on the station cradle before a robot returns it
  random?: () => number;
};

export const cellPos = (c: Cell): Vec3 => ({ x: c[0] * PITCH, y: c[2] * LEVEL_H, z: c[1] * PITCH });
const key = (c: Cell) => `${c[0]},${c[1]},${c[2]}`;
const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export class Fleet {
  t = 0;
  done = 0;
  cycles: number[] = [];
  queue: number[] = [];
  returns: number[] = []; // bins waiting at a station whose hold has run out
  parked = new Map<number, number>(); // bin id → the time a robot may take it back
  robots: FleetRobot[] = [];
  bins: Bin[] = [];
  storage: Cell[] = [];
  elevLevel = 0; // animated carriage height, in levels
  elevFor: number | null = null; // robot currently granted the shaft
  private held = new Map<string, number>(); // cell → robot id
  private feed = 0;
  private opts: FleetOpts;
  private attach: number;
  private clamp: number;
  private rnd: () => number;
  private rowMin: number;
  private rowMax: number;

  constructor(opts: FleetOpts) {
    this.opts = opts;
    this.attach = opts.attachAt ?? 0.87;
    this.clamp = opts.clamp ?? 0.46;
    this.rnd = opts.random ?? Math.random;
    this.rowMin = Math.min(0, ...opts.stations.map((s) => s[1]));
    this.rowMax = Math.max(...opts.rows);

    const lastCol = opts.sideAisle ? opts.cols - 1 : opts.cols;
    for (let lv = 1; lv <= opts.levels; lv++)
      for (const r of opts.rows) for (let c = 0; c < lastCol; c++) this.storage.push([c, r, lv]);

    let id = 0;
    this.storage.forEach((c, i) => {
      if (i % opts.fillEvery !== opts.fillEvery - 1)
        this.bins.push({ id: id++, cell: [c[0], c[1], c[2]], carriedBy: null });
    });

    this.robots = opts.robotStart.map((col, i) => {
      const cell: Cell = [col, 0, 0];
      this.held.set(this.ckey(cell), i);
      return {
        id: i,
        cell,
        pos: cellPos(cell),
        path: [],
        phase: 'idle',
        after: 'idle',
        lift: 0,
        grip: 0,
        spin: 0,
        heading: 0,
        binId: null,
        target: null,
        goal: null,
        station: -1,
        dwell: 0,
        vel: 0,
        blocked: 0,
        startedAt: 0,
        trips: 0,
        returning: false,
      };
    });
  }

  bin(id: number | null) {
    return id === null ? undefined : this.bins.find((b) => b.id === id);
  }

  /** Queue a bin for the picking station: the given one, or any free one. */
  request(id?: number): boolean {
    const free = this.bins.filter(
      (b) => b.cell && b.carriedBy === null && !this.queue.includes(b.id) && (id === undefined || b.id === id),
    );
    if (!free.length) return false;
    this.queue.push(free[Math.floor(this.rnd() * free.length)].id);
    return true;
  }

  // ── the grid ──────────────────────────────────────────────────────────────
  private walkable(c: Cell): boolean {
    const [ec, er] = this.opts.elevator;
    // the shaft is reachable from every deck — it is the way between them
    if (c[0] === ec && c[1] === er) return true;
    if (c[0] < 0 || c[0] >= this.opts.cols) return false;
    if (c[2] === 0) return c[1] >= this.rowMin && c[1] <= this.rowMax;
    // Upper decks: every row from the front aisle (0) to the last storage row —
    // the rows between storage rows are aisles a loaded robot can use.
    return c[1] >= 0 && c[1] <= this.rowMax;
  }

  private isShaft(c: Cell) {
    return c[0] === this.opts.elevator[0] && c[1] === this.opts.elevator[1];
  }

  /** The landing: the walkable square beside the shaft on a level, where a robot waits for the carriage. */
  private landing(lv: number): Cell {
    const [ec, er] = this.opts.elevator;
    const c = ([[ec - 1, er], [ec + 1, er], [ec, er + 1], [ec, er - 1]] as const)
      .map(([x, z]) => [x, z, lv] as Cell)
      .find((n) => !this.isShaft(n) && this.walkable(n));
    if (!c) throw new Error('the shaft has no landing');
    return c;
  }

  /**
   * The reservation key. The shaft is a single physical place however high the
   * carriage happens to be, so it keys without its level — which is what stops
   * a rising robot from landing on one already standing at that floor.
   */
  private ckey(c: Cell) {
    return this.isShaft(c) ? 'shaft' : key(c);
  }

  private blockedBy(c: Cell, id: number): boolean {
    const h = this.held.get(this.ckey(c));
    return h !== undefined && h !== id;
  }

  /** Squares a robot may step onto from c — never the shaft, which is only entered by boarding. */
  private neighbours(c: Cell): Cell[] {
    return ([
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      .map(([dx, dz]) => [c[0] + dx, c[1] + dz, c[2]] as Cell)
      .filter((n) => this.walkable(n) && !this.isShaft(n));
  }

  /** True while this robot's bin is on its deck (a stored bin sits too low to pass under). */
  private loaded(id: number): boolean {
    const b = this.bin(this.robots[id].binId);
    return !!b && b.cell === null;
  }

  /**
   * A* across one level, treating squares held by other robots as walls. The
   * search state is (cell, arrival direction) with a small cost on turning,
   * so routes come out as straight runs with deliberate corners — the way a
   * real traffic controller would lay them — instead of staircases.
   *
   * A loaded robot carries its bin lifted, far too tall to pass under a
   * stored bin, so stored squares are walls for it; every storage row borders
   * an aisle, so a way round always exists. Should the layout ever leave none
   * (a test's odd grid), the search runs again with them merely expensive.
   */
  private findPath(from: Cell, to: Cell, id: number): Cell[] | null {
    if (!this.loaded(id)) return this.search(from, to, id, null);
    const stored = new Set(this.bins.flatMap((b) => (b.cell ? [key(b.cell)] : [])));
    return this.search(from, to, id, stored, Infinity) ?? this.search(from, to, id, stored, 10);
  }

  private search(from: Cell, to: Cell, id: number, stored: Set<string> | null, UNDER_BIN = 0): Cell[] | null {
    if (same(from, to)) return [];
    const lv = from[2];
    const TURN = 0.4;
    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;
    const h = (c: Cell) => Math.abs(c[0] - to[0]) + Math.abs(c[1] - to[1]);
    type Node = { c: Cell; d: number; g: number; f: number };
    const skey = (c: Cell, d: number) => `${c[0]},${c[1]},${d}`;
    const open: Node[] = [{ c: from, d: -1, g: 0, f: h(from) }];
    const came = new Map<string, { c: Cell; d: number }>();
    const best = new Map<string, number>([[skey(from, -1), 0]]);
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (same(cur.c, to)) {
        const path: Cell[] = [];
        let node = { c: cur.c, d: cur.d };
        while (!same(node.c, from)) {
          path.unshift(node.c);
          node = came.get(skey(node.c, node.d))!;
        }
        return path;
      }
      for (let di = 0; di < DIRS.length; di++) {
        const [dx, dz] = DIRS[di];
        const nb: Cell = [cur.c[0] + dx, cur.c[1] + dz, lv];
        if (!this.walkable(nb) || (this.isShaft(nb) && !same(nb, to))) continue;
        if (this.blockedBy(nb, id) && !same(nb, to)) continue;
        const under = stored?.has(key(nb)) && !same(nb, to) ? UNDER_BIN : 0;
        if (under === Infinity) continue;
        const g = cur.g + 1 + (cur.d !== -1 && cur.d !== di ? TURN : 0) + under;
        const nk = skey(nb, di);
        if (g >= (best.get(nk) ?? Infinity)) continue;
        best.set(nk, g);
        came.set(nk, { c: cur.c, d: cur.d });
        open.push({ c: nb, d: di, g, f: g + h(nb) });
      }
    }
    return null;
  }

  private setGoal(r: FleetRobot, goal: Cell, after: Phase): boolean {
    const path = this.findPath(r.cell, goal, r.id);
    if (!path) return false;
    this.dropClaimsBut(r);
    r.goal = goal;
    r.path = path;
    r.after = after;
    r.blocked = 0;
    return true;
  }

  private dropClaimsBut(r: FleetRobot) {
    for (const [k, v] of this.held) if (v === r.id && k !== this.ckey(r.cell)) this.held.delete(k);
  }

  /** Distance until this robot must be at corner speed (or stopped). */
  private runway(r: FleetRobot): { dist: number; endV: number } {
    let d = Math.hypot(
      cellPos(r.path[0]).x - r.pos.x,
      cellPos(r.path[0]).z - r.pos.z,
    );
    for (let i = 0; i + 1 < r.path.length; i++) {
      const a = r.path[i];
      const b = r.path[i + 1];
      // a direction change at a — the profile must be down to CORNER_V there
      const prev = i === 0 ? r.cell : r.path[i - 1];
      if (a[0] - prev[0] !== b[0] - a[0] || a[1] - prev[1] !== b[1] - a[1])
        return { dist: d, endV: CORNER_V };
      // an unclaimed square ahead also ends the runway
      if (this.blockedBy(b, r.id)) return { dist: d, endV: 0 };
      d += PITCH;
    }
    return { dist: d, endV: 0 }; // the end of the path: arrive at rest
  }

  /** Advance along the reserved path. Returns true when it arrives. */
  private drive(r: FleetRobot, dt: number): boolean {
    if (!r.path.length) {
      r.vel = 0;
      return true;
    }
    const next = r.path[0];
    if (this.blockedBy(next, r.id)) {
      r.vel = 0;
      r.blocked += dt;
      // Mutual block — I want the square a robot holds, and that robot is
      // itself stuck behind someone. Symmetric waiting can never resolve a
      // swap or a rotation, so the rule is asymmetric and immediate: the
      // higher id steps aside, the lower id keeps its claim and proceeds.
      const holderId = this.held.get(this.ckey(next));
      const other = holderId !== undefined ? this.robots[holderId] : undefined;
      const otherStuck =
        other &&
        (other.path.length === 0 || this.blockedBy(other.path[0], other.id)) &&
        other.phase !== 'present';
      if (otherStuck && r.id > other.id) {
        const aside = this.neighbours(r.cell).find(
          (c) => !this.blockedBy(c, r.id) && !this.held.has(this.ckey(c)),
        );
        if (aside) {
          this.dropClaimsBut(r);
          r.path = [aside];
          r.blocked = 0;
          return false;
        }
      }
      if (r.blocked >= YIELD_AFTER) {
        // A stand-off: two robots each waiting on the square the other holds.
        // Stepping aside onto any free neighbour breaks the symmetry, and the
        // re-plan on the next tick picks the route up again.
        const aside = this.neighbours(r.cell).find(
          (c) => !this.blockedBy(c, r.id) && !this.held.has(this.ckey(c)),
        );
        if (aside) {
          this.dropClaimsBut(r);
          r.path = [aside];
          r.blocked = 0;
          return false;
        }
        r.blocked = 0;
      } else if (r.blocked > REPLAN_AFTER && r.goal) {
        // keep the clock running — if re-routing cannot help, the yield above
        // is what eventually breaks the stand-off. When the stored goal is on
        // another level, this leg's goal is the shaft: A* is single-level, so
        // feeding it the far cell would return null on every blocked tick.
        const legGoal: Cell = r.goal[2] !== r.cell[2] ? this.landing(r.cell[2]) : r.goal;
        const alt = this.findPath(r.cell, legGoal, r.id);
        if (alt && alt.length && alt[0] && !this.blockedBy(alt[0], r.id)) {
          this.dropClaimsBut(r);
          r.path = alt;
        }
      }
      return false;
    }
    r.blocked = 0;

    // trapezoidal speed: ramp up, but never faster than the braking distance
    // to the next corner or stop allows (v² = endV² + 2·a·d)
    const { dist: runway, endV } = this.runway(r);
    const vAllow = Math.min(SPEED, Math.sqrt(endV * endV + 2 * ACCEL * Math.max(0, runway)));
    r.vel = r.vel < vAllow ? Math.min(vAllow, r.vel + ACCEL * dt) : vAllow;
    let step = r.vel * dt;

    // consume waypoints until the step is spent (no teleporting, no overshoot)
    while (step > 1e-7 && r.path.length) {
      const wp = r.path[0];
      if (this.blockedBy(wp, r.id)) break;
      this.held.set(this.ckey(wp), r.id);
      const goal = cellPos(wp);
      const dx = goal.x - r.pos.x;
      const dz = goal.z - r.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) r.heading = Math.atan2(dx, dz);
      if (dist <= step) {
        const from = r.cell;
        r.pos = { ...goal };
        r.cell = wp;
        r.path.shift();
        step -= dist;
        if (this.ckey(from) !== this.ckey(wp)) {
          this.held.delete(this.ckey(from));
          if (this.isShaft(from) && this.elevFor === r.id) this.elevFor = null; // stepped off: the carriage is free
        }
      } else {
        r.pos = {
          x: r.pos.x + (dx / dist) * step,
          y: goal.y,
          z: r.pos.z + (dz / dist) * step,
        };
        step = 0;
      }
    }
    if (!r.path.length) r.vel = 0;
    return r.path.length === 0;
  }

  /** A station cell on the travel deck. */
  atStation(c: Cell): boolean {
    return c[2] === 0 && this.opts.stations.some(([sc, sr]) => sc === c[0] && sr === c[1]);
  }

  /** An unclaimed picking station — one no robot is heading for and no bin is sitting on. */
  private freeStation(): number {
    return this.opts.stations.findIndex(
      ([sc, sr], si) =>
        !this.robots.some((r) => r.station === si) &&
        !this.bins.some((b) => b.cell && b.cell[0] === sc && b.cell[1] === sr && b.cell[2] === 0),
    );
  }

  private freeStorage(): Cell | null {
    const taken = (c: Cell) =>
      this.bins.some((b) => b.cell && same(b.cell, c)) ||
      this.robots.some((r) => r.target && same(r.target, c));
    const empty = this.storage.filter((c) => !taken(c));
    return empty.length ? empty[Math.floor(this.rnd() * empty.length)] : null;
  }

  /** The driving phase that goes with a given arrival intent. */
  private drivePhase(after: Phase): Phase {
    return after === 'spread' ? 'toBin' : after === 'present' ? 'toStation' : 'toShelf';
  }

  /**
   * Send the robot to `dest`, riding the elevator first when the levels differ.
   * Returns false when no line is open right now; the caller stays in its
   * current phase and tries again next tick.
   */
  private head(r: FleetRobot, dest: Cell, after: Phase): boolean {
    if (dest[2] === r.cell[2]) {
      if (!this.setGoal(r, dest, after)) return false;
      r.phase = this.drivePhase(after);
      return true;
    }
    if (!this.setGoal(r, this.landing(r.cell[2]), after)) return false;
    r.goal = dest; // the landing is only the first leg
    r.phase = 'toLift';
    return true;
  }

  step(dt: number) {
    this.t += dt;
    for (const [id, at] of this.parked)
      if (this.t >= at && !this.returns.includes(id)) this.returns.push(id);

    this.feed += dt;
    if (this.opts.autoFeed !== false && this.feed >= FEED_EVERY) {
      this.feed = 0;
      if (this.queue.length < 3) this.request();
    }

    for (const r of this.robots) {
      switch (r.phase) {
        case 'idle': {
          // a bin whose picking time is up goes back to storage before new work
          const back = this.returns[0];
          const id = back ?? this.queue[0];
          const b = this.bin(id ?? null);
          if (b?.cell) {
            const dest: Cell = [b.cell[0], b.cell[1], b.cell[2]];
            const ok = this.head(r, dest, 'spread');
            if (ok) {
              if (back !== undefined) {
                this.returns.shift();
                this.parked.delete(b.id);
                r.returning = true;
              } else this.queue.shift();
              r.binId = b.id;
              b.carriedBy = r.id;
              r.startedAt = this.t;
              r.target = dest;
            }
          } else if (this.atStation(r.cell)) {
            // it has just left a bin at a station: clear the square for the next delivery
            this.head(r, [this.opts.robotStart[r.id], 0, 0], 'idle');
          }
          break;
        }

        case 'toBin': {
          if (this.drive(r, dt)) {
            if (r.goal && !same(r.cell, r.goal)) this.setGoal(r, r.goal, r.after); // yielded — resume
            else r.phase = 'spread';
          }
          break;
        }

        // the hub turns and the tabs run out past the bin's footprint
        case 'spread': {
          r.grip = Math.min(1, r.grip + dt / GRIP_TIME);
          r.spin += (dt / GRIP_TIME) * Math.PI * 0.5;
          if (r.grip >= 1) r.phase = 'liftUp';
          break;
        }

        case 'liftUp': {
          r.lift = Math.min(1, r.lift + dt / LIFT_TIME);
          const b = this.bin(r.binId);
          // the deck meets the bin's underside and takes it off the cradle
          if (b && b.cell && r.lift >= this.attach) b.cell = null;
          if (r.lift >= 1) r.phase = 'lock';
          break;
        }

        // the hub turns back until the tabs meet the bin's sides — clamped, and it stays lifted
        case 'lock': {
          r.grip = Math.max(this.clamp, r.grip - dt / GRIP_TIME);
          r.spin -= (dt / GRIP_TIME) * Math.PI * 0.5;
          if (r.grip <= this.clamp) {
            if (r.returning) {
              const home = this.freeStorage();
              if (home) {
                r.target = home;
                this.head(r, home, 'unlock');
              }
              break;
            }
            const si = this.freeStation();
            if (si >= 0) {
              r.station = si;
              const s = this.opts.stations[si];
              if (!this.head(r, [s[0], s[1], 0], 'present')) r.station = -1;
            }
          }
          break;
        }

        case 'toLift': {
          if (this.drive(r, dt) && r.goal) {
            const landing = this.landing(r.cell[2]);
            if (same(r.cell, landing)) r.phase = 'waitLift';
            else {
              // A yield step ended somewhere else. Route back to the landing —
              // it is only a waypoint, so the real destination must survive.
              const dest = r.goal;
              if (this.setGoal(r, landing, r.after)) r.goal = dest;
            }
          }
          break;
        }

        // on the landing: take the carriage when it is free, bring it to this floor, drive on
        case 'waitLift': {
          if (this.elevFor === null) this.elevFor = r.id;
          if (this.elevFor !== r.id) {
            // someone else has the carriage and will need this landing to step off —
            // waiting here is the deadlock, so stand aside until the shaft is free
            const aside = this.neighbours(r.cell).find((c) => !this.isShaft(c) && !this.held.has(this.ckey(c)));
            if (aside) {
              this.dropClaimsBut(r);
              r.path = [aside];
              r.phase = 'holdLift';
            }
            break;
          }
          const here = r.cell[2];
          const d = here - this.elevLevel;
          const stepLv = (ELEV_SPEED * dt) / LEVEL_H;
          this.elevLevel += Math.sign(d) * Math.min(Math.abs(d), stepLv);
          if (Math.abs(d) < 1e-3) {
            this.elevLevel = here;
            const [ec, er] = this.opts.elevator;
            const shaft: Cell = [ec, er, here];
            if (!this.blockedBy(shaft, r.id)) {
              this.dropClaimsBut(r);
              r.path = [shaft];
              r.phase = 'board';
            }
          }
          break;
        }

        case 'holdLift': {
          this.drive(r, dt);
          if (!r.path.length && this.elevFor === null && r.goal) {
            const dest = r.goal;
            if (this.setGoal(r, this.landing(r.cell[2]), r.after)) {
              r.goal = dest;
              r.phase = 'toLift';
            }
          }
          break;
        }

        case 'board': {
          if (this.drive(r, dt)) r.phase = 'riding';
          break;
        }

        case 'riding': {
          const [ec, er] = this.opts.elevator;
          const want = r.goal ? r.goal[2] : 0;
          const dy = want - this.elevLevel;
          const stepLv = (ELEV_SPEED * dt) / LEVEL_H;
          this.elevLevel += Math.sign(dy) * Math.min(Math.abs(dy), stepLv);
          // the robot rides with the carriage; its claimed square does not
          // change until it steps off, so nobody can take the landing
          r.pos = { x: ec * PITCH, y: this.elevLevel * LEVEL_H, z: er * PITCH };
          if (Math.abs(want - this.elevLevel) < 1e-3) {
            this.elevLevel = want;
            const arrived: Cell = [ec, er, want];
            r.cell = arrived; // same 'shaft' reservation, new floor
            this.held.set(this.ckey(arrived), r.id);
            r.pos = cellPos(arrived);
            const dest = r.goal!;
            if (same(dest, arrived)) {
              r.phase = r.after;
            } else if (this.setGoal(r, dest, r.after)) {
              r.phase = this.drivePhase(r.after);
            } else {
              // no line open yet (robots waiting round the landing): step off onto the
              // landing anyway so the shaft is free, and keep asking for a route from there —
              // the ordinary yield rules then sort the crowd out
              const landing = this.landing(want);
              if (!this.blockedBy(landing, r.id)) {
                this.dropClaimsBut(r);
                r.path = [landing];
                r.goal = dest;
                r.phase = this.drivePhase(r.after);
              }
            }
          }
          break;
        }

        case 'toStation': {
          if (this.drive(r, dt)) {
            if (r.goal && !same(r.cell, r.goal)) {
              this.setGoal(r, r.goal, r.after);
              break;
            }
            r.phase = 'present';
            r.dwell = 0;
            r.trips += 1;
            this.done += 1;
            this.cycles.push(this.t - r.startedAt);
          }
          break;
        }

        case 'present': {
          r.dwell += dt;
          if (r.dwell < DWELL) break;
          const hold = this.opts.stationHold;
          if (hold !== undefined) {
            // leave the bin on the station cradle for the picker and go back to work;
            // a robot fetches it home once the hold runs out
            if (r.binId !== null) this.parked.set(r.binId, this.t + hold);
            r.station = -1;
            r.target = [r.cell[0], r.cell[1], r.cell[2]];
            r.phase = 'unlock';
            break;
          }
          const home = this.freeStorage();
          if (home) {
            r.station = -1;
            r.target = home;
            this.head(r, home, 'unlock');
          }
          break;
        }

        case 'toShelf': {
          if (this.drive(r, dt)) {
            if (r.goal && !same(r.cell, r.goal)) this.setGoal(r, r.goal, r.after);
            else r.phase = r.after === 'idle' ? 'idle' : 'unlock'; // 'idle': an empty run home
          }
          break;
        }

        // tabs spread clear so the bin is free to land
        case 'unlock': {
          r.grip = Math.min(1, r.grip + dt / GRIP_TIME);
          r.spin += (dt / GRIP_TIME) * Math.PI * 0.5;
          if (r.grip >= 1) r.phase = 'setDown';
          break;
        }

        case 'setDown': {
          r.lift = Math.max(0, r.lift - dt / LIFT_TIME);
          const b = this.bin(r.binId);
          // the cradle catches the bin as the deck passes back under it
          if (b && r.target && !b.cell && r.lift <= this.attach) {
            b.cell = [r.target[0], r.target[1], r.target[2]];
            b.carriedBy = null;
            r.binId = null;
          }
          if (r.lift <= 0) r.phase = 'stow';
          break;
        }

        case 'stow': {
          r.grip = Math.max(0, r.grip - dt / GRIP_TIME);
          r.spin -= (dt / GRIP_TIME) * Math.PI * 0.5;
          if (r.grip <= 0) {
            r.target = null;
            r.goal = null;
            r.returning = false;
            this.dropClaimsBut(r);
            r.phase = 'idle';
          }
          break;
        }
      }
    }
  }

  avgCycle(): number | null {
    return this.cycles.length ? this.cycles.reduce((a, b) => a + b, 0) / this.cycles.length : null;
  }
}

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'IDLE',
  toBin: 'DRIVE → BIN',
  spread: 'SPREAD',
  liftUp: 'LIFT',
  lock: 'LOCK',
  toLift: 'TO LIFT',
  waitLift: 'CALL LIFT',
  holdLift: 'WAIT LIFT',
  board: 'BOARD',
  riding: 'ELEVATOR',
  toStation: 'CARRY → STN',
  present: 'PRESENT',
  toShelf: 'CARRY → SHELF',
  unlock: 'UNLOCK',
  setDown: 'SET DOWN',
  stow: 'STOW',
};
