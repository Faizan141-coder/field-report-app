/**
 * Drives the real UploadEngine against the real server with no React Native involved.
 *   cd server && PORT=4100 DATA_DIR=/tmp/frs-headless npm start
 *   cd app && npx tsx headless/run.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UploadEngine} from '../src/core/engine';
import {classifyStatus} from '../src/core/errors';
import {Report, ReportApi, ReportStore} from '../src/core/types';

// The server's `drop` / `dropMidBody` faults destroy sockets on purpose. Node's built-in fetch
// occasionally reports the resulting ECONNRESET as an uncaught error on a connection nobody is
// waiting on (the in-flight request itself rejects normally and is handled by the engine).
// Tolerate exactly that, and nothing else, so the harness isn't flaky.
process.on('uncaughtException', err => {
  if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
    console.warn('(ignoring stray ECONNRESET from a deliberately destroyed socket)');
    return;
  }
  throw err;
});

const BASE = process.env.SERVER ?? 'http://localhost:4100';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frs-'));
const CHUNK = 16 * 1024;

const memStore = (disk: Map<string, string>): ReportStore => ({
  loadAll: async () => [...disk.values()].map(v => JSON.parse(v)),
  save: async r => void disk.set(r.id, JSON.stringify(r)),
  remove: async id => void disk.delete(id),
});

let requests = 0;
const api: ReportApi = {
  async uploadImage({reportId, index, uri, bytes, signal, onProgress}) {
    const buf = fs.readFileSync(uri);
    const st = await fetch(`${BASE}/reports/${reportId}/images/${index}/status`, {signal});
    let offset = ((await st.json()) as {received: number}).received;
    while (offset < bytes) {
      const end = Math.min(offset + CHUNK, bytes);
      requests++;
      const res = await fetch(`${BASE}/reports/${reportId}/images/${index}`, {
        method: 'PUT',
        headers: {'Content-Range': `bytes ${offset}-${end - 1}/${bytes}`},
        body: buf.subarray(offset, end),
        signal,
      });
      const body: any = await res.json().catch(() => undefined);
      if (res.status === 409 && typeof body?.offset === 'number') { offset = body.offset; continue; }
      if (!res.ok) throw classifyStatus(res.status, body);
      offset = body.received;
      onProgress(offset);
    }
  },
  async commit(a, signal) {
    requests++;
    const res = await fetch(`${BASE}/reports/${a.id}`, {
      method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(a), signal,
    });
    if (!res.ok) throw classifyStatus(res.status, await res.json().catch(() => undefined));
  },
};

function mkEngine(disk: Map<string, string>, online = () => true) {
  return new UploadEngine({
    store: memStore(disk), api,
    preparer: {prepare: async uri => ({uri, bytes: fs.statSync(uri).size})},
    files: {remove: async () => {}},
    isOnline: online, stallMs: 1500, random: () => 0,
  });
}
const fault = (f: object) => fetch(`${BASE}/admin/faults`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(f)});
const clear = () => fetch(`${BASE}/admin/faults`, {method: 'DELETE'});
const reset = () => fetch(`${BASE}/admin/reset`, {method: 'DELETE'});
const server = async () => ((await (await fetch(`${BASE}/reports`)).json()) as any).reports as any[];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const sums = new Map<string, string[]>();
function makeDraft(n: number, imgs: number, kb = 200) {
  const id = `h-${n}-${crypto.randomBytes(6).toString('hex')}`;
  const uris = Array.from({length: imgs}, (_, i) => {
    const b = crypto.randomBytes(kb * 1024);
    const p = path.join(tmp, `${id}-${i}.jpg`);
    fs.writeFileSync(p, b);
    return {p, h: crypto.createHash('md5').update(b).digest('hex')};
  });
  sums.set(id, uris.map(u => u.h));
  return {id, description: `report ${n}`, imageUris: uris.map(u => u.p)};
}
async function settle(e: UploadEngine, ms = 60_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (e.getSnapshot().every(r => r.phase === 'uploaded' || r.phase === 'needsAttention')) return;
    await sleep(100);
  }
  throw new Error('did not settle: ' + JSON.stringify(e.getSnapshot().map(r => [r.id, r.phase, r.lastError?.message])));
}
async function verify(ids: string[]) {
  const reports = await server();
  const out: string[] = [];
  for (const id of ids) {
    const m = reports.filter(r => r.id === id);
    if (m.length !== 1) { out.push(`${id}: on server ${m.length}x`); continue; }
    for (let i = 0; i < m[0].images.length; i++) {
      const b = Buffer.from(await (await fetch(m[0].images[i].url)).arrayBuffer());
      if (crypto.createHash('md5').update(b).digest('hex') !== sums.get(id)![i]) out.push(`${id}[${i}]: bytes differ`);
    }
  }
  return out;
}
const check = (name: string, problems: string[]) => {
  console.log(problems.length ? `FAIL ${name}\n  ${problems.join('\n  ')}` : `PASS ${name}`);
  if (problems.length) process.exitCode = 1;
};

(async () => {
  let disk = new Map<string, string>();
  let e = mkEngine(disk);
  if (!process.env.ONLY) {
  // 1. baseline
  await reset(); await clear();
  disk = new Map(); e = mkEngine(disk); await e.init();
  const d1 = [makeDraft(1, 3), makeDraft(2, 5), makeDraft(3, 1)];
  for (const d of d1) await e.enqueue(d);
  await settle(e);
  check('baseline: 3 reports land once, bytes identical', await verify(d1.map(d => d.id)));

  // 2. every network fault, many times, and the app "restarts" in the middle
  await reset();
  disk = new Map(); e = mkEngine(disk); await e.init();
  const d2 = [makeDraft(4, 3), makeDraft(5, 5), makeDraft(6, 2)];
  await fault({mode: 'loseResponse', times: 4});
  for (const d of d2) await e.enqueue(d);
  await sleep(1200);
  // simulate force-quit: abandon engine A, new engine from what's on "disk"
  e = mkEngine(disk); await e.init();
  await fault({mode: 'dropMidBody', times: 3, dropAfterBytes: 5000});
  await sleep(2500);
  await fault({mode: 'drop', times: 3});
  await sleep(3000);
  await fault({mode: 'error500', times: 3});
  await sleep(2500);
  await fault({mode: 'hang', times: 2});
  await settle(e, 90_000);
  check('faults + restarts: exactly once, bytes identical', await verify(d2.map(d => d.id)));

  }
  // 3. offline: nothing is sent, then reconnect delivers
  await reset(); await clear();
  disk = new Map(); let online = false; e = mkEngine(disk, () => online); await e.init();
  const d3 = [makeDraft(7, 2)];
  await e.enqueue(d3[0]);
  await sleep(800);
  const heldOffline = (await server()).length === 0 && e.getSnapshot()[0].phase === 'queued';
  online = true; e.nudge(); await settle(e);
  check('offline holds, reconnect delivers', [...(heldOffline ? [] : ['sent while offline']), ...(await verify([d3[0].id]))]);

  // 4. permanent error must not be retried
  await reset();
  disk = new Map(); e = mkEngine(disk); await e.init();
  await fault({mode: 'reject400', times: 0});
  requests = 0;
  await e.enqueue(makeDraft(8, 1));
  await settle(e); const before = requests; await sleep(4000);
  const snap = e.getSnapshot()[0];
  check('400 is not retried', [
    ...(snap.phase === 'needsAttention' ? [] : [`phase=${snap.phase}`]),
    ...(requests === before && before <= 2 ? [] : [`requests=${requests} (was ${before})`]),
  ]);
  await clear();
  process.exit();
})();
