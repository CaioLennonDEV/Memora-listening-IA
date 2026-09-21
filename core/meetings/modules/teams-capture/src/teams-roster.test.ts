/**
 * Wave 2 live roster — pure rosterFromTeamsPresence + stream-wrapper scan proofs.
 * Run: npx tsx src/teams-roster.test.ts
 */
import { rosterFromTeamsPresence, scanTeamsStreamRoster } from './msteams-speakers.js';

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
  const empty = rosterFromTeamsPresence({ tMs: 1, surfaces: [], panelPeople: null });
  check('no tiles + no panel → unreliable', empty.reliable === false);
  check('unreliable → humanCount null', humanCount(empty) === null);
}

{
  const alone = rosterFromTeamsPresence({
    tMs: 2,
    surfaces: [{ id: 'bot', name: 'Vexa', isSelf: true }],
    panelPeople: [],
  });
  check('bot-only tiles + open empty panel → reliable', alone.reliable === true);
  check('bot-only → humans 0', humanCount(alone) === 0);
}

{
  const two = rosterFromTeamsPresence({
    tMs: 3,
    surfaces: [
      { id: 'bot', name: 'Vexa', isSelf: true },
      { id: 'a', name: 'Alice', isSelf: false },
      { id: 'b', isSelf: false },
    ],
    panelPeople: null,
  });
  check('tiles without panel → reliable', two.reliable === true);
  check('2 humans', humanCount(two) === 2);
}

{
  const merged = rosterFromTeamsPresence({
    tMs: 4,
    surfaces: [
      { id: 'tile-1', isSelf: false },
      { id: 'bot', name: 'Vexa', isSelf: true },
    ],
    panelPeople: [
      { id: 'roster:alice', name: 'Alice', isSelf: false },
      { id: 'roster:bob', name: 'Bob', isSelf: false },
    ],
  });
  const humans = humanCount(merged);
  check('panel + unnamed tile → ≥2 humans', humans !== null && humans >= 2, String(humans));
}

{
  const dedup = rosterFromTeamsPresence({
    tMs: 5,
    surfaces: [{ id: 't1', name: 'Alice', isSelf: false }],
    panelPeople: [{ id: 'roster:alice', name: 'Alice', isSelf: false }],
  });
  check('tile+panel same name dedupes to 1', humanCount(dedup) === 1);
  check('keeps a name', dedup.people.some((p) => p.name === 'Alice'));
}

{
  // Shared-root poison: tile walk wrongly saw only the bot; stream wrappers still name both.
  const fromStream = rosterFromTeamsPresence({
    tMs: 6,
    surfaces: [
      { id: 'stream:vexa', name: 'Vexa', isSelf: true },
      { id: 'stream:alice', name: 'Alice', isSelf: false },
      // poisoned canonical tile (bot only) — must not erase Alice
      { id: 'tile-root', name: 'Vexa', isSelf: true },
    ],
    panelPeople: null,
  });
  check('stream+poisoned tile still counts Alice', humanCount(fromStream) === 1);
}

{
  // Minimal fake DOM: two stream wrappers; bot name must not swallow the other via self scan.
  // Same HTMLElement=Object trick as roster-panel.test.ts (stubs are plain objects).
  (globalThis as any).HTMLElement = Object;
  const bot = {
    getAttribute: (k: string) => (k === 'data-tid' ? 'Vexa' : k === 'data-stream-type' ? 'Video' : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  const human = {
    getAttribute: (k: string) => (k === 'data-tid' ? 'Alice Smith' : k === 'data-stream-type' ? 'Video' : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  const root = {
    querySelectorAll(sel: string) {
      if (sel === '[data-stream-type][data-tid]') return [bot, human];
      return [];
    },
  } as unknown as ParentNode;
  const people = scanTeamsStreamRoster(root, 'Vexa');
  check('stream scan finds 2 people', people.length === 2, JSON.stringify(people));
  check('stream scan marks bot self', people.some((p) => p.isSelf && p.name === 'Vexa'));
  check('stream scan keeps human', people.some((p) => !p.isSelf && p.name === 'Alice Smith'));
  const snap = rosterFromTeamsPresence({ tMs: 7, surfaces: people, panelPeople: null });
  check('stream scan → 1 human', humanCount(snap) === 1);
}

if (failed) {
  console.error(`\n❌ teams-roster: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ teams-roster: presence reliable/unreliable + humans + panel merge + stream scan');
