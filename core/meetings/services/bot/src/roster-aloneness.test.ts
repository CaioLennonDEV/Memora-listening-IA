/**
 * Offline proofs for roster aloneness composition — run: npx tsx src/roster-aloneness.test.ts
 */
import {
  combineAloneness,
  createRosterAlonenessSource,
  type RosterSnapshot,
} from './roster.js';
import type { AlonenessSource } from './ports.js';

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(cond ? `  ✅ ${name}` : `  ❌ ${name}`);
  if (!cond) failed++;
}

function snap(partial: Partial<RosterSnapshot> & { people: RosterSnapshot['people'] }): RosterSnapshot {
  return { tMs: 0, reliable: true, ...partial };
}

/** Arm but never auto-fire — these cases drive leave via observe ticks + injected `now`. */
const inertTimer = () => ({ clear: () => { /* */ } });

{
  let t = 0;
  const alone: number[] = [];
  const src = createRosterAlonenessSource({ debounceMs: 1000, now: () => t, setTimer: () => inertTimer() });
  src.onAlone(() => alone.push(t));
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('debounce not yet', alone.length === 0);
  t = 999;
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('still before debounce', alone.length === 0);
  t = 1000;
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('leave after debounce', alone.length === 1 && alone[0] === 1000);
  t = 2000;
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('fires once', alone.length === 1);
}

{
  const hits: string[] = [];
  const silence: AlonenessSource = {
    onAlone(cb) {
      // never fires in this test — roster is the leave path
      return () => { /* */ };
    },
  };
  let t = 0;
  const roster = createRosterAlonenessSource({ debounceMs: 100, now: () => t, setTimer: () => inertTimer() });
  combineAloneness(silence, roster).onAlone(() => hits.push('leave'));
  roster.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  t = 100;
  roster.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('combined roster path fires leave', hits.length === 1);
}

{
  // Wall-clock timer: a SINGLE alone snapshot must leave after debounce — no second tick required.
  let now = 0;
  const alone: number[] = [];
  let scheduled: { fn: () => void; ms: number } | null = null;
  const src = createRosterAlonenessSource({
    debounceMs: 500,
    now: () => now,
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { clear: () => { scheduled = null; } };
    },
  });
  src.onAlone(() => alone.push(now));
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('timer armed on first alone', scheduled?.ms === 500);
  check('not fired before timer', alone.length === 0);
  now = 500;
  scheduled?.fn();
  check('timer fire leaves without second observe', alone.length === 1);
}

{
  // Alone before onAlone wires (join → active): pending alone must arm when the callback lands.
  let now = 0;
  const alone: number[] = [];
  let scheduled: { fn: () => void; ms: number } | null = null;
  const src = createRosterAlonenessSource({
    debounceMs: 200,
    now: () => now,
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { clear: () => { scheduled = null; } };
    },
  });
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('no timer before onAlone', scheduled === null);
  src.onAlone(() => alone.push(now));
  check('onAlone arms pending alone', scheduled?.ms === 200);
  now = 200;
  scheduled?.fn();
  check('pending alone leaves after debounce', alone.length === 1);
}

{
  // Human returns cancels the armed timer — but only after a sustained streak (not a 1-scan flicker).
  let cancelled = false;
  let scheduled: { fn: () => void; ms: number } | null = null;
  const src = createRosterAlonenessSource({
    debounceMs: 1000,
    cancelStreakNeeded: 3,
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { clear: () => { cancelled = true; scheduled = null; } };
    },
  });
  src.onAlone(() => { /* */ });
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('timer armed', scheduled != null);
  src.observe(snap({ people: [{ id: 'a', isSelf: false }] }));
  check('single human flicker keeps timer', scheduled != null && !cancelled);
  src.observe(snap({ people: [{ id: 'a', isSelf: false }] }));
  check('second human still keeps timer', scheduled != null && !cancelled);
  src.observe(snap({ people: [{ id: 'a', isSelf: false }] }));
  check('third consecutive human clears timer', cancelled && scheduled === null);
}

{
  // Teams alone-room pattern: humans 0,1,0,1… must still leave when the wall clock fires.
  let now = 0;
  const alone: number[] = [];
  let scheduled: { fn: () => void; ms: number } | null = null;
  const src = createRosterAlonenessSource({
    debounceMs: 600,
    cancelStreakNeeded: 3,
    now: () => now,
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { clear: () => { scheduled = null; } };
    },
  });
  src.onAlone(() => alone.push(now));
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('flicker: armed', scheduled?.ms === 600);
  src.observe(snap({ people: [{ id: 'ghost', isSelf: false }] }));
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  src.observe(snap({ people: [{ id: 'ghost', isSelf: false }] }));
  src.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('flicker: timer survived 0↔1', scheduled != null);
  now = 600;
  scheduled?.fn();
  check('flicker: leave still fires', alone.length === 1);
}

if (failed) {
  console.error(`\n❌ roster-aloneness: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ roster-aloneness');
