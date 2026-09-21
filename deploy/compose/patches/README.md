# Bot JS overlays (no image rebuild)

Hosted STT returns 400 without `Idempotency-Key`. Hub `vexaai/vexa-bot:v012` may omit it.

## One-time extract + patch (CMD)

```bat
cd /d C:\Users\caiolfv\Documents\vexa\deploy\compose\patches

docker create --name vexa-bot-extract vexaai/vexa-bot:v012
docker cp vexa-bot-extract:/app/core/meetings/modules/whisper/dist/transcription-client.js .\transcription-client.js
docker rm vexa-bot-extract

node patch-idempotency.mjs
```

Then in `deploy/compose/.env`:

```env
HOST_BOT_WHISPER_CLIENT=C:/Users/caiolfv/Documents/vexa/deploy/compose/patches/transcription-client.js
```

Recreate runtime (no build) and send the bot again:

```bat
cd /d C:\Users\caiolfv\Documents\vexa\deploy\compose
docker compose up -d --no-build --force-recreate runtime
```

## Wave 1/2 live roster (Meet + Teams) — why `— in the room` stays

Rebuilding **only the Terminal** shows `— in the room` (UI). The **Hub bot image** still has no roster publisher, so SSE never gets `type:"roster"` and the count never becomes `2 in the room`.

### Fix under SonicWALL (no `docker build` of vexa-bot)

Does **not** need `pnpm install` (that OOM'd on this machine). Uses Hub image extract + esbuild:

```bat
cd /d C:\Users\caiolfv\Documents\vexa\deploy\compose\patches
build-roster-overlay.cmd
```

If it asks for esbuild:

```bat
cd /d C:\Users\caiolfv\Documents\vexa\deploy\compose\patches
npm install esbuild@0.25.0 --no-save
build-roster-overlay.cmd
```

That fills `patches/bot-roster/`.

`.env` (already set if you pull this tree):

```env
HOST_BOT_DIST_OVERLAY=C:/Users/caiolfv/Documents/vexa/deploy/compose/patches/bot-roster/dist
HOST_BOT_BROWSER_UTILS=C:/Users/caiolfv/Documents/vexa/deploy/compose/patches/bot-roster/browser-utils.global.js
BOT_ROSTER_ALONE_DEBOUNCE_MS=45000
```

Recreate the Python path + runtime (hot-mounts ingest + SSE + spawn overlays):

```bat
cd /d C:\Users\caiolfv\Documents\vexa\deploy\compose
docker compose up -d --no-build --force-recreate runtime meeting-api agent-api
```

**Stop the current bot and send Meet / Teams / Zoom again.** Expect header `N in the room` within a few seconds of tiles appearing. Bot logs should mention `roster alone debounce_ms=`.

Waves covered by the same overlay rebuild:

| Platform | Presence signal in browser-utils |
|---|---|
| Google Meet | `createGmeetSpeakers` → `onRoster` / tiles |
| Microsoft Teams | `createTeamsSpeakers` → `onRoster` / tiles + open roster panel |
| Zoom | `createZoomSpeakers` → `onRoster` / name footers |

### What each mount does

| Env / volume | Container path |
|---|---|
| `HOST_BOT_DIST_OVERLAY` | `/app/core/meetings/services/bot/dist` |
| `HOST_BOT_BROWSER_UTILS` | `/app/browser-utils.global.js` |
| compose bind `ingest.py` | meeting-api collector roster branch |
| compose bind `control_plane/api.py` | agent-api SSE `type:roster` |
| compose bind `profiles.py` + `docker_backend.py` | runtime forwards env + mounts overlays |

Empty `BOT_ROSTER_ALONE_DEBOUNCE_MS` keeps the bot's 45s default. Silence leave (`BOT_ALONE_SILENCE_WINDOW_MS`) remains independent.
