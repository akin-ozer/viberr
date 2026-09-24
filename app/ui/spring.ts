/**
 * Gesture physics for the surfaces a person throws things across: the board's
 * drag and drop, and the controller dock's bottom sheet.
 *
 * A spring in Apple's two designer parameters ("Designing Fluid Interfaces",
 * WWDC 2018): `dampingRatio` — 1 is critically damped and settles without
 * overshoot, below 1 overshoots — and `response`, roughly the seconds it takes
 * to get there. Response is NOT a duration: a spring has none, its settle time
 * falls out of the pair. Mass is 1, so stiffness is (2π / response)² and the
 * damping coefficient 4π·ζ / response.
 *
 * Why a spring and not a curve: a fixed curve starts at its own speed, not the
 * pointer's. `cubic-bezier(.23, 1, .32, 1)` leaves at about four times its
 * average speed, so a card let go of at rest lurched off at once, and a card
 * let go of mid-throw first stopped dead. A spring starts at whatever velocity
 * it is handed, so the release is seamless both ways.
 *
 * WAAPI and CSS have no spring timing, so the motion is sampled: 60 frames a
 * second, one spring per axis, until it is at rest. Each axis gets its own
 * spring because a 2D throw has two velocities: one spring on the distance
 * can carry only the part of the throw that points at the target, and drops
 * the rest at the release.
 */

export interface Spring {
  /** 1 = critically damped (no overshoot); below 1 overshoots. Above 1 is treated as 1. */
  dampingRatio: number;
  /** Seconds, roughly the time to reach the target. Lower is snappier. */
  response: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A sampled flight: frames 1/60 s apart, and how long they take in ms. */
export interface SpringFlight {
  frames: Point[];
  duration: number;
}

const FPS = 60;
/** Close enough to rest, in px and px/s: under half a pixel and barely moving. */
const REST_DISTANCE = 0.5;
const REST_SPEED = 20;
/** A spring that has not settled by then is cut there; the last frame is the target. */
const MAX_SECONDS = 1;

/**
 * The spring's displacement from its target `t` seconds in, starting `x0` away
 * with velocity `v0` (units per second; positive moves the value up, so a value
 * below its target heading for it has x0 < 0 and v0 > 0).
 */
export function springAt(spring: Spring, x0: number, v0: number, t: number): number {
  const w = (2 * Math.PI) / spring.response;
  const z = Math.min(spring.dampingRatio, 1);
  if (z >= 1) return Math.exp(-w * t) * (x0 + (v0 + w * x0) * t);
  const wd = w * Math.sqrt(1 - z * z);
  return (
    Math.exp(-z * w * t) *
    (x0 * Math.cos(wd * t) + ((v0 + z * w * x0) / wd) * Math.sin(wd * t))
  );
}

/**
 * The frames of a move from `from` to `to` under `spring`, the move carrying
 * `velocity` (px/s) at its first frame. The first frame is `from`, the last is
 * exactly `to`, and they are 1/60 s apart — hand them to `element.animate` with
 * `duration` and linear easing.
 */
export function springFrames(
  spring: Spring,
  from: Point,
  to: Point,
  velocity: Point = { x: 0, y: 0 },
): SpringFlight {
  const x0 = from.x - to.x;
  const y0 = from.y - to.y;
  const frames: Point[] = [{ ...from }];
  const dt = 1 / FPS;
  for (let i = 1; i <= MAX_SECONDS * FPS; i++) {
    const t = i * dt;
    const dx = springAt(spring, x0, velocity.x, t);
    const dy = springAt(spring, y0, velocity.y, t);
    // Speed over the next frame, per axis, so an underdamped spring passing
    // through its target at speed is not mistaken for one at rest.
    const vx = (springAt(spring, x0, velocity.x, t + dt) - dx) / dt;
    const vy = (springAt(spring, y0, velocity.y, t + dt) - dy) / dt;
    const resting =
      Math.hypot(dx, dy) < REST_DISTANCE && Math.hypot(vx, vy) < REST_SPEED;
    if (resting || i === MAX_SECONDS * FPS) {
      frames.push({ ...to });
      break;
    }
    frames.push({ x: to.x + dx, y: to.y + dy });
  }
  return { frames, duration: ((frames.length - 1) * 1000) / FPS };
}

/**
 * The progress (0 → 1) of a move that starts at rest, sampled into `count`
 * frames, for a companion motion that has to land on the same frame as a
 * `springFrames` flight (the board's closing hole).
 */
export function springProgress(spring: Spring, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(i === count - 1 ? 1 : 1 - springAt(spring, 1, 0, i / FPS));
  }
  return out;
}

/**
 * Where a throw comes to rest: Apple's momentum projection, the exponential
 * decay a scroll view decelerates by ("Designing Fluid Interfaces" sample
 * code; `decelerationRate` 0.998 is UIScrollView's normal rate). Not the
 * textbook v²/2a: this is the curve people already know from scrolling. A
 * release decides where it is going by adding this to where it is.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Rubber-banding past a bound: how far an element follows a pointer that is
 * `overshoot` px past the edge, with `dimension` the size of the thing being
 * pulled. The further past, the less it follows, so an edge reads as "there is
 * nothing more here" instead of as frozen. Signed like `overshoot`, and never
 * as far as it.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * The inverse of `rubberband`: the pull past the edge that draws an element
 * `visible` px past it. A drag that catches a rubber-banded element works
 * from here, so the element stays where it was caught. `visible` is always
 * short of `dimension` (the band never gets there), so this is defined.
 */
export function unrubberband(visible: number, dimension: number, constant = 0.55): number {
  return (visible * dimension) / (constant * (dimension - Math.abs(visible)));
}

/** How far back a release looks for the pointer's velocity, and how long a pause kills it. */
const VELOCITY_WINDOW_MS = 100;
const STILL_AFTER_MS = 50;
/** A flick faster than this is noise from a coalesced event, not intent. */
const MAX_SPEED = 8000;

/**
 * The pointer's velocity at release, from the last few move samples — not the
 * last two, which a single coalesced event can make wild. A pointer that has
 * not moved for `STILL_AFTER_MS` is at rest, whatever it did before.
 */
export function createVelocityTracker() {
  let samples: { x: number; y: number; t: number }[] = [];
  return {
    reset() {
      samples = [];
    },
    push(x: number, y: number, t: number) {
      samples.push({ x, y, t });
      while (samples.length > 2 && t - samples[0]!.t > VELOCITY_WINDOW_MS) samples.shift();
    },
    velocity(now: number): Point {
      const last = samples[samples.length - 1];
      const first = samples.find((s) => last !== undefined && last.t - s.t <= VELOCITY_WINDOW_MS);
      // No span of time (two samples in one clock tick) is no measurement:
      // 0/0 would hand the spring NaN.
      if (!last || !first || last.t <= first.t || now - last.t > STILL_AFTER_MS) {
        return { x: 0, y: 0 };
      }
      const seconds = (last.t - first.t) / 1000;
      const clamp = (v: number) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
      return {
        x: clamp((last.x - first.x) / seconds),
        y: clamp((last.y - first.y) / seconds),
      };
    },
  };
}
