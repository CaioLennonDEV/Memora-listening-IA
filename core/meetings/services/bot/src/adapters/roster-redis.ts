/**
 * Live roster egress — XADD `{type:"roster"}` onto `transcription_segments`.
 * Same durable feed the collector consumes for transcript / retract / session_end.
 */
import type { RosterSnapshot } from '../roster.js';
import type { RedisTranscriptClient } from './transcript-redis.js';
import { TRANSCRIPTION_STREAM } from './transcript-redis.js';

export interface RosterPublishPayload extends RosterSnapshot {
  /** Human count (non-self); must match people after omitting isSelf. */
  humans: number;
}

export interface RosterPublisherOptions {
  client: RedisTranscriptClient;
  meetingId: string | number;
  nativeMeetingId?: string;
}

export interface RosterPublisher {
  publish(snapshot: RosterPublishPayload): Promise<void>;
}

/** Build the roster publisher. People with `isSelf: true` are stripped from the wire payload. */
export function createRosterPublisher(opts: RosterPublisherOptions): RosterPublisher {
  const { client, meetingId, nativeMeetingId } = opts;

  return {
    async publish(snapshot: RosterPublishPayload): Promise<void> {
      const people = snapshot.people
        .filter((p) => !p.isSelf)
        .map((p) => (p.name !== undefined ? { id: p.id, name: p.name } : { id: p.id }));
      const payload = JSON.stringify({
        type: 'roster',
        meeting_id: meetingId,
        native_meeting_id: nativeMeetingId,
        tMs: snapshot.tMs,
        reliable: snapshot.reliable,
        humans: snapshot.humans,
        people,
      });
      await client.xAdd(TRANSCRIPTION_STREAM, '*', { payload });
    },
  };
}
