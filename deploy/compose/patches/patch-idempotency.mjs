/**
 * Patch Hub vexa-bot's transcription-client.js to send Idempotency-Key
 * (required by transcription.vexa.ai external STT). Run AFTER docker cp of the file.
 *
 *   node patch-idempotency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(dir, 'transcription-client.js');

if (!fs.existsSync(target)) {
  console.error('Missing transcription-client.js — run the docker cp first (see README in this folder).');
  process.exit(1);
}

let t = fs.readFileSync(target, 'utf8');
if (t.includes('Idempotency-Key')) {
  console.log('already patched:', target);
  process.exit(0);
}

const insert = "'Idempotency-Key': crypto.randomUUID(),";
const patterns = [
  // tsc ESM, single quotes + template boundary
  [
    /('Content-Type':\s*`multipart\/form-data; boundary=\$\{boundary\}`,)/,
    `$1\n            ${insert}`,
  ],
  // double-quoted Content-Type
  [
    /("Content-Type":\s*`multipart\/form-data; boundary=\$\{boundary\}`,)/,
    `$1\n            ${insert}`,
  ],
];

let ok = false;
for (const [re, rep] of patterns) {
  if (re.test(t)) {
    t = t.replace(re, rep);
    ok = true;
    break;
  }
}

if (!ok) {
  console.error('Could not find Content-Type header needle in transcription-client.js');
  console.error('Open the file and add Idempotency-Key next to Content-Type manually.');
  process.exit(1);
}

fs.writeFileSync(target, t);
console.log('patched OK:', target);
