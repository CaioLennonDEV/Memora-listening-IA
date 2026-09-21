/**
 * Wave 3 live roster — pure rosterFromZoomTiles proofs.
 * Run: npx tsx src/zoom-roster.test.ts
 */
import { rosterFromZoomTiles } from './zoom-speakers.js';

function humanCount(snapshot: { reliable: boolean; people: { isSelf: boolean }[] }): number | null {
  if (!snapshot.reliable) return null;
  return snapshot.people.reduce((n, p) => n + (p.isSelf ? 0 : 1), 0);
}

let failed = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
};

{
  const empty = rosterFromZoomTiles([], 1, 'Vexa');
  check('no tiles → unreliable', empty.reliable === false);
  check('unreliable → humanCount null', humanCount(empty) === null);
}

{
  const alone = rosterFromZoomTiles([{ name: 'Vexa' }], 2, 'Vexa');
  check('self only → reliable', alone.reliable === true);
  check('self only → humans 0', humanCount(alone) === 0);
  check('self flagged', alone.people[0]?.isSelf === true);
}

{
  const two = rosterFromZoomTiles(
    [{ name: 'Vexa' }, { name: 'Alice' }, { name: 'Bob' }],
    3,
    'Vexa',
  );
  check('2 humans', humanCount(two) === 2);
}

{
  const dedup = rosterFromZoomTiles(
    [{ name: 'Alice' }, { name: 'Alice' }, { name: '  Alice  ' }],
    4,
    'Bot',
  );
  check('dedupe by normalized name', humanCount(dedup) === 1);
}

{
  const caseSelf = rosterFromZoomTiles([{ name: 'vexa bot' }], 5, 'Vexa Bot');
  check('self match is case-insensitive', humanCount(caseSelf) === 0);
}

if (failed) {
  console.error(`\n❌ zoom-roster: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ zoom-roster: reliable/unreliable + self + dedupe');
