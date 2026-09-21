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

/** Push-driven AlonenessSource: observe() snapshots; onAlone fires after debounce. */
export function createRosterAlonenessSource(options: {
  debounceMs: number;
  now?: () => number;
}): AlonenessSource & { observe(snapshot: RosterSnapshot): void } {
  const now = options.now ?? Date.now;
  const watch = new RosterAloneWatch(options.debounceMs);
  let leaveCb: (() => void) | null = null;
  let fired = false;

  return {
    observe(snapshot: RosterSnapshot): void {
      if (fired || !leaveCb) return;
      if (watch.onSnapshot(snapshot, now()) === 'leave') {
        fired = true;
        leaveCb();
      }
    },
    onAlone(callback: () => void): () => void {
      leaveCb = callback;
      return () => { leaveCb = null; };
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
