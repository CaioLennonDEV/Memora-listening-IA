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

{
  let t = 0;
  const alone: number[] = [];
  const src = createRosterAlonenessSource({ debounceMs: 1000, now: () => t });
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
  const roster = createRosterAlonenessSource({ debounceMs: 100, now: () => t });
  combineAloneness(silence, roster).onAlone(() => hits.push('leave'));
  roster.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  t = 100;
  roster.observe(snap({ people: [{ id: 'b', isSelf: true }] }));
  check('combined roster path fires leave', hits.length === 1);
}

if (failed) {
  console.error(`\n❌ roster-aloneness: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ roster-aloneness');
