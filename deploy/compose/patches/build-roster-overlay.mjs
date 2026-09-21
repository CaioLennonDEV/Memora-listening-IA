/**
 * Build Wave 1/2 bot roster overlay without `pnpm install` (SonicWALL / low-memory safe).
 *
 * 1. Copy Hub bot `dist/` + browser-utils from vexaai/vexa-bot:v012
 * 2. Transpile changed bot TS into that dist with esbuild
 * 3. Rebuild browser-utils.global.js from capture *source* (aliases, no workspace link)
 *
 * Run: node build-roster-overlay.mjs
 * From: deploy/compose/patches/
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BOT = path.join(ROOT, 'core', 'meetings', 'services', 'bot');
const MODULES = path.join(ROOT, 'core', 'meetings', 'modules');
const OUT = path.join(__dirname, 'bot-roster');
const IMAGE = process.env.BROWSER_IMAGE || 'vexaai/vexa-bot:v012';
const TMP = 'vexa-bot-roster-extract';

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function which(bin) {
  const r = spawnSync(bin, ['--version'], { shell: true, stdio: 'ignore' });
  return r.status === 0;
}

async function loadEsbuild() {
  const candidates = [
    path.join(BOT, 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(__dirname, 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return (await import(pathToFileURL(p).href)).default;
    }
  }
  console.log('esbuild missing locally — npm install esbuild@0.25.0 in patches/ (tiny, no monorepo)…');
  run('npm', ['install', 'esbuild@0.25.0', '--no-save', '--prefix', __dirname]);
  const installed = path.join(__dirname, 'node_modules', 'esbuild', 'lib', 'main.js');
  if (!fs.existsSync(installed)) {
    console.error('ERROR: could not install esbuild');
    process.exit(1);
  }
  return (await import(pathToFileURL(installed).href)).default;
}

function esbuildCli(args) {
  run('npx', ['--yes', 'esbuild', ...args]);
}

function dockerCp() {
  if (!which('docker')) {
    console.error('ERROR: docker not on PATH');
    process.exit(1);
  }
  spawnSync('docker', ['rm', '-f', TMP], { shell: true, stdio: 'ignore' });
  run('docker', ['create', '--name', TMP, IMAGE]);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'dist'), { recursive: true });
  run('docker', ['cp', `${TMP}:/app/core/meetings/services/bot/dist/.`, path.join(OUT, 'dist')]);
  run('docker', ['cp', `${TMP}:/app/browser-utils.global.js`, path.join(OUT, 'browser-utils.base.js')]);
  spawnSync('docker', ['rm', '-f', TMP], { shell: true, stdio: 'ignore' });
}

function transpileBot() {
  const files = [
    ['src/roster.ts', 'dist/roster.js'],
    ['src/adapters/roster-redis.ts', 'dist/adapters/roster-redis.js'],
    ['src/index.ts', 'dist/index.js'],
    ['src/capture-bridge.ts', 'dist/capture-bridge.js'],
  ];
  fs.mkdirSync(path.join(OUT, 'dist', 'adapters'), { recursive: true });
  for (const [srcRel, outRel] of files) {
    const entry = path.join(BOT, srcRel);
    const outfile = path.join(OUT, outRel);
    if (!fs.existsSync(entry)) {
      console.error(`ERROR: missing ${entry}`);
      process.exit(1);
    }
    esbuildCli([
      entry,
      `--outfile=${outfile}`,
      '--format=esm',
      '--platform=node',
      '--target=node20',
      '--log-level=warning',
    ]);
  }
}

async function buildBrowserUtils(esbuild) {
  const entry = `
import { createGmeetCapture, createGmeetSpeakers, createGmeetCaptureV1, pickBoundName, GmeetChannelBinder, createPcmCaptureNode } from ${JSON.stringify(path.join(MODULES, 'gmeet-capture/src/index.ts').replace(/\\/g, '/'))};
import { createMixedAudioCapture, installRemoteAudioHook, selectTeamsMixStreams, mainAudioProvedSilent, createCsrcPoll } from ${JSON.stringify(path.join(MODULES, 'mixed-capture-core/src/index.ts').replace(/\\/g, '/'))};
import { createRecordingTap } from ${JSON.stringify(path.join(MODULES, 'record-chunker/src/index.ts').replace(/\\/g, '/'))};
import { createJitsiSpeakers, createJitsiChat, sendJitsiChatMessage } from ${JSON.stringify(path.join(MODULES, 'jitsi-capture/src/index.ts').replace(/\\/g, '/'))};
import { createTeamsSpeakers, createTeamsCaptions } from ${JSON.stringify(path.join(MODULES, 'teams-capture/src/index.ts').replace(/\\/g, '/'))};
import { createZoomSpeakers, createTrackNameResolver } from ${JSON.stringify(path.join(MODULES, 'zoom-capture/src/index.ts').replace(/\\/g, '/'))};

const VexaBrowserUtils = {
  createGmeetCapture, createGmeetSpeakers, createGmeetCaptureV1, pickBoundName, GmeetChannelBinder, createPcmCaptureNode,
  createMixedAudioCapture, installRemoteAudioHook, selectTeamsMixStreams, mainAudioProvedSilent, createCsrcPoll,
  createRecordingTap,
  createJitsiSpeakers, createJitsiChat, sendJitsiChatMessage,
  createTeamsSpeakers, createTeamsCaptions,
  createZoomSpeakers, createTrackNameResolver,
};
globalThis.VexaBrowserUtils = VexaBrowserUtils;
if (typeof window !== 'undefined') window.VexaBrowserUtils = VexaBrowserUtils;
`;
  const entryFile = path.join(OUT, '_browser-utils-entry.mjs');
  fs.writeFileSync(entryFile, entry);

  const alias = {
    '@vexa/capture-codec': path.join(MODULES, 'capture-codec/src/index.ts'),
  };
  const outfile = path.join(OUT, 'browser-utils.global.js');

  if (esbuild) {
    await esbuild.build({
      entryPoints: [entryFile],
      outfile,
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      alias,
      logLevel: 'warning',
    });
  } else {
    console.error('ERROR: esbuild module unavailable');
    process.exit(1);
  }
  fs.unlinkSync(entryFile);
}

console.log(`[1/3] extract Hub bot dist from ${IMAGE}…`);
dockerCp();

console.log('[2/3] transpile Wave roster bot modules into overlay dist…');
transpileBot();

console.log('[3/3] rebuild browser-utils.global.js from capture source…');
const esbuild = await loadEsbuild();
await buildBrowserUtils(esbuild);

console.log(`
OK: ${OUT}

.env should have:
  HOST_BOT_DIST_OVERLAY=${OUT.replace(/\\/g, '/')}/dist
  HOST_BOT_BROWSER_UTILS=${OUT.replace(/\\/g, '/')}/browser-utils.global.js

Then:
  cd /d ${path.join(ROOT, 'deploy', 'compose')}
  docker compose up -d --no-build --force-recreate runtime meeting-api agent-api

Stop bot + send Meet again.
`);
