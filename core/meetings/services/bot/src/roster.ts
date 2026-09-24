/**
 * Live observed roster — human count + alone-leave debounce (Wave 1 contract).
 * Spec: docs/superpowers/specs/2026-09-21-live-roster-alone-leave-design.md
 */
import type { AlonenessSource } from './ports.js';

export type RosterPerson = { id: string; name?: string; isSelf: boolean };

export type RosterSnapshot = {
  tMs: number;
  people: RosterPerson[];
  /** false when the platform UI gave no usable roster/tiles this scan */
  reliable: boolean;
};

/** Human count when reliable; `null` when the scan must not drive leave/UI as empty. */
export function humanCount(snapshot: RosterSnapshot): number | null {
  if (!snapshot.reliable) return null;
  let n = 0;
  for (const p of snapshot.people) {
    if (!p.isSelf) n += 1;
  }
  return n;
}

/**
 * Debounced "only the bot remains" watch. Unreliable snapshots never start/advance leave.
 * A reliable humans>0 cancels the timer. Leave fires once humans===0 for `debounceMs`.
 *
 * Pure clock helper — the live source also arms a real `setTimeout` so leave does not depend on
 * a later roster tick arriving after the debounce window (a single "0 humans" publish is enough).
 */
export class RosterAloneWatch {
  private aloneSinceMs: number | null = null;

  constructor(private readonly debounceMs: number) {}

  onSnapshot(snapshot: RosterSnapshot, nowMs: number): 'stay' | 'leave' {
    const humans = humanCount(snapshot);
    if (humans === null) return 'stay';
    if (humans > 0) {
      this.aloneSinceMs = null;
      return 'stay';
    }
    if (this.aloneSinceMs == null) this.aloneSinceMs = nowMs;
    if (nowMs - this.aloneSinceMs >= this.debounceMs) return 'leave';
    return 'stay';
  }
}

export const DEFAULT_ROSTER_ALONE_DEBOUNCE_MS = 45_000;

/**
 * How many consecutive reliable humans>0 snapshots are required to CANCEL an armed leave.
 * Teams alone-room scans flicker 0↔1 (ghost tile / bot tile not marked isSelf) about once per
 * second — a single humans>0 must not reset the 60s leave clock or the bot never exits.
 */
export const ROSTER_LEAVE_CANCEL_STREAK = 3;

export function resolveRosterAloneDebounceMs(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(`[bot] ${message}`),
): number {
  const raw = env.BOT_ROSTER_ALONE_DEBOUNCE_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
    warn(`BOT_ROSTER_ALONE_DEBOUNCE_MS=${JSON.stringify(raw)} is invalid; using the 45s default`);
  }
  return DEFAULT_ROSTER_ALONE_DEBOUNCE_MS;
}

type ClearableTimer = { clear: () => void };

/** Push-driven AlonenessSource: observe() snapshots; onAlone fires after debounce. */
export function createRosterAlonenessSource(options: {
  debounceMs: number;
  now?: () => number;
  /** Injectable clock for tests — default is `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ClearableTimer;
  /** Override cancel hysteresis (tests). */
  cancelStreakNeeded?: number;
}): AlonenessSource & { observe(snapshot: RosterSnapshot): void } {
  const now = options.now ?? Date.now;
  const cancelStreakNeeded = options.cancelStreakNeeded ?? ROSTER_LEAVE_CANCEL_STREAK;
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const id = setTimeout(fn, ms);
    return { clear: () => clearTimeout(id) };
  });
  const watch = new RosterAloneWatch(options.debounceMs);
  let leaveCb: (() => void) | null = null;
  let fired = false;
  let timer: ClearableTimer | null = null;
  /** Last reliable alone/not-alone — survives unreliable scans; used to arm when onAlone wires late. */
  let alonePending = false;
  /** Consecutive reliable humans>0 while a leave timer is armed — see ROSTER_LEAVE_CANCEL_STREAK. */
  let humanStreak = 0;

  const clearTimer = (): void => {
    timer?.clear();
    timer = null;
  };

  const fire = (): void => {
    if (fired || !leaveCb) return;
    fired = true;
    clearTimer();
    humanStreak = 0;
    console.log(`[bot] roster alone: leaving after ${options.debounceMs}ms debounce`);
    leaveCb();
  };

  const armTimer = (): void => {
    if (fired || !leaveCb || timer) return;
    console.log(`[bot] roster alone: armed leave in ${options.debounceMs}ms`);
    timer = setTimer(fire, options.debounceMs);
  };

  return {
    observe(snapshot: RosterSnapshot): void {
      if (fired) return;
      const humans = humanCount(snapshot);
      // Unreliable: do not start, cancel, or advance — empty DOM ≠ empty room.
      if (humans === null) return;

      if (humans > 0) {
        humanStreak += 1;
        // Flicker of a ghost tile (Teams alone: 0↔1 every scan) must NOT reset the leave clock.
        if (humanStreak < cancelStreakNeeded) {
          console.log(
            `[bot] roster alone: humans=${humans} streak=${humanStreak}/${cancelStreakNeeded} (leave timer kept)`,
          );
          return;
        }
        alonePending = false;
        humanStreak = 0;
        clearTimer();
        watch.onSnapshot(snapshot, now());
        console.log(`[bot] roster alone: humans>0 confirmed — leave cancelled`);
        return;
      }

      humanStreak = 0;
      alonePending = true;
      // Keep the pure watch in sync (tests + late observe after debounce).
      if (leaveCb && watch.onSnapshot(snapshot, now()) === 'leave') {
        fire();
        return;
      }
      // Arm a wall-clock timer on first reliable alone so leave does not require another tick
      // after debounceMs (UI can show "0 in the room" from a single publish while scans stall).
      if (leaveCb) armTimer();
    },
    onAlone(callback: () => void): () => void {
      leaveCb = callback;
      // Room was already empty before the active-phase subscription — start the clock now.
      if (alonePending) armTimer();
      return () => {
        leaveCb = null;
        clearTimer();
      };
    },
  };
}

/** Fire when ANY source reports alone (silence OR roster). First fire wins per subscription. */
export function combineAloneness(...sources: AlonenessSource[]): AlonenessSource {
  return {
    onAlone(callback: () => void): () => void {
      let fired = false;
      const once = (): void => {
        if (fired) return;
        fired = true;
        callback();
      };
      const stops = sources.map((s) => s.onAlone(once));
      return () => { for (const stop of stops) stop(); };
    },
  };
}
