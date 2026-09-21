/**
 * Offline proofs for roster-redis — run: npx tsx src/adapters/roster-redis.test.ts
 */
import { createRosterPublisher } from './roster-redis.js';
import { TRANSCRIPTION_STREAM, type RedisTranscriptClient } from './transcript-redis.js';

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(cond ? `  ✅ ${name}` : `  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
}

function fakeClient() {
  const adds: { key: string; id: string; fields: Record<string, string> }[] = [];
  const client: RedisTranscriptClient = {
    async xAdd(key, id, fields) { adds.push({ key, id, fields }); },
    async publish() { /* unused */ },
  };
  return { client, adds };
}

{
  const { client, adds } = fakeClient();
  const pub = createRosterPublisher({ client, meetingId: 13, nativeMeetingId: 'abc-defg-hij' });
  await pub.publish({
    tMs: 123,
    reliable: true,
    humans: 2,
    people: [
      { id: 'bot', name: 'Vexa', isSelf: true },
      { id: 'a', name: 'Alice', isSelf: false },
      { id: 'c', isSelf: false },
    ],
  });
  check('xAdd once', adds.length === 1);
  check('stream = transcription_segments', adds[0]?.key === TRANSCRIPTION_STREAM, adds[0]?.key);
  const raw = adds[0]?.fields.payload;
  check('payload field present', typeof raw === 'string');
  const parsed = JSON.parse(raw!) as {
    type: string; meeting_id: unknown; native_meeting_id?: string;
    tMs: number; reliable: boolean; humans: number; people: { id: string; name?: string; isSelf?: boolean }[];
  };
  check('type=roster', parsed.type === 'roster');
  check('meeting_id threaded', parsed.meeting_id === 13);
  check('native stamped', parsed.native_meeting_id === 'abc-defg-hij');
  check('humans=2', parsed.humans === 2);
  check('self omitted from people', parsed.people.length === 2 && !parsed.people.some((p) => p.isSelf));
  check('Alice kept', parsed.people.some((p) => p.id === 'a' && p.name === 'Alice'));
}

if (failed) {
  console.error(`\n❌ roster-redis: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ roster-redis');
