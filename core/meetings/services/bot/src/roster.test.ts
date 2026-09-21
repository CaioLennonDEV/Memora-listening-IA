/**
 * Offline proofs for roster.ts — run: npx tsx src/roster.test.ts
 */
import { humanCount, RosterAloneWatch, type RosterSnapshot } from './roster.js';

function snap(partial: Partial<RosterSnapshot> & { people: RosterSnapshot['people'] }): RosterSnapshot {
  return { tMs: 0, reliable: true, ...partial };
}

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(cond ? `  ✅ ${name}` : `  ❌ ${name}`);
  if (!cond) failed++;
}

{
  check('unreliable → null', humanCount(snap({ reliable: false, people: [] })) === null);
  check('self only → 0', humanCount(snap({ people: [{ id: 'b', isSelf: true }] })) === 0);
  check(
    'self+2 humans → 2',
    humanCount(
      snap({
        people: [
          { id: 'b', isSelf: true },
          { id: 'a', name: 'A', isSelf: false },
          { id: 'c', isSelf: false },
        ],
      }),
    ) === 2,
  );
}

{
  const w = new RosterAloneWatch(1000);
  check('humans>0 → stay', w.onSnapshot(snap({ people: [{ id: 'a', isSelf: false }] }), 0) === 'stay');
  check('unreliable empty → stay', w.onSnapshot(snap({ reliable: false, people: [] }), 500) === 'stay');
  check('humans0 t=0 → stay (debounce)', w.onSnapshot(snap({ people: [{ id: 'b', isSelf: true }] }), 0) === 'stay');
  check('humans0 before debounce → stay', w.onSnapshot(snap({ people: [{ id: 'b', isSelf: true }] }), 999) === 'stay');
  check('humans0 after debounce → leave', w.onSnapshot(snap({ people: [{ id: 'b', isSelf: true }] }), 1000) === 'leave');
  const w2 = new RosterAloneWatch(1000);
  w2.onSnapshot(snap({ people: [{ id: 'b', isSelf: true }] }), 0);
  w2.onSnapshot(snap({ people: [{ id: 'a', isSelf: false }] }), 500);
  check('human returns cancels leave', w2.onSnapshot(snap({ people: [{ id: 'b', isSelf: true }] }), 2000) === 'stay');
}

if (failed) {
  console.error(`\n❌ roster: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ roster.ts');
