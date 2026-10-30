import express, {NextFunction, Request, Response} from 'express';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 4000);
const DATA = path.resolve(process.env.DATA_DIR ?? 'data');
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const imgPath = (id: string, idx: number) => path.join(DATA, 'images', id, `${idx}.jpg`);
const reportPath = (id: string) => path.join(DATA, 'reports', `${id}.json`);
fs.mkdirSync(path.join(DATA, 'images'), {recursive: true});
fs.mkdirSync(path.join(DATA, 'reports'), {recursive: true});

// ---- fault injection -------------------------------------------------------
// Applies to /reports writes (image PUT + finalize PUT). `times` counts down per
// matching request; 0 = until cleared. See README "Making it fail".
type FaultMode =
  | 'none'
  | 'error500' // transient server error -> client should retry
  | 'error503' // transient, with Retry-After
  | 'reject400' // permanent client error -> client must NOT retry
  | 'hang' // accept the request, never answer
  | 'drop' // destroy the socket immediately
  | 'dropMidBody' // read ~dropAfterBytes of the body then destroy the socket
  | 'loseResponse'; // process + persist the write, then destroy the socket (lost ack)

interface Faults {
  mode: FaultMode;
  times: number;
  latencyMs: number;
  dropAfterBytes: number;
}
let faults: Faults = {mode: 'none', times: 0, latencyMs: 0, dropAfterBytes: 20_000};
let remaining = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const app = express();

app.use((req, _res, next) => {
  console.log(new Date().toISOString().slice(11, 23), req.method, req.url);
  next();
});

app.get('/health', (_req, res) => void res.json({ok: true}));

app.post('/admin/faults', express.json(), (req, res) => {
  faults = {...faults, mode: 'none', times: 0, latencyMs: 0, ...req.body};
  remaining = faults.times;
  console.log('faults ->', faults);
  res.json(faults);
});
app.delete('/admin/faults', (_req, res) => {
  faults = {mode: 'none', times: 0, latencyMs: 0, dropAfterBytes: 20_000};
  remaining = 0;
  res.json(faults);
});
app.delete('/admin/reset', (_req, res) => {
  fs.rmSync(DATA, {recursive: true, force: true});
  fs.mkdirSync(path.join(DATA, 'images'), {recursive: true});
  fs.mkdirSync(path.join(DATA, 'reports'), {recursive: true});
  res.json({ok: true});
});

/** Returns the fault to apply to this request (consuming one use), or 'none'. */
function takeFault(): FaultMode {
  if (faults.mode === 'none') return 'none';
  if (faults.times > 0) {
    if (remaining <= 0) return 'none';
    remaining--;
  }
  return faults.mode;
}

async function faultGate(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'PUT') return next();
  if (faults.latencyMs) await sleep(faults.latencyMs);
  const mode = takeFault();
  res.locals.fault = mode;
  switch (mode) {
    case 'error500':
      return void res.status(500).json({error: 'injected 500'});
    case 'error503':
      return void res.status(503).set('Retry-After', '2').json({error: 'injected 503'});
    case 'reject400':
      return void res.status(400).json({error: 'injected 400'});
    case 'hang':
      return; // never respond; socket stays open until client gives up
    case 'drop':
      return void req.socket.destroy();
    default:
      return next();
  }
}
app.use('/reports', faultGate);

// ---- images ----------------------------------------------------------------
// Resumable: a client sends `Content-Range: bytes start-end/total` chunks. Bytes land in
// <idx>.part and the file is renamed into place when the last byte arrives. A chunk that
// doesn't start at the server's offset gets 409 {offset}; GET .../status tells a client
// where to resume. Without Content-Range the body is the whole image.
const partPath = (id: string, idx: number) => `${imgPath(id, idx)}.part`;
const received = (id: string, idx: number) =>
  fs.existsSync(partPath(id, idx)) ? fs.statSync(partPath(id, idx)).size : 0;

app.get('/reports/:id/images/:idx/status', (req, res) => {
  const idx = Number(req.params.idx);
  const complete = fs.existsSync(imgPath(req.params.id, idx));
  res.json({complete, received: complete ? fs.statSync(imgPath(req.params.id, idx)).size : received(req.params.id, idx)});
});

app.put('/reports/:id/images/:idx', (req, res) => {
  const {id} = req.params;
  const idx = Number(req.params.idx);
  if (!/^[\w-]{8,64}$/.test(id) || !Number.isInteger(idx) || idx < 0 || idx > 4) {
    return void res.status(400).json({error: 'bad id/index'});
  }
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
  const declared = Number(req.headers['content-length'] ?? 0);
  const start = range ? Number(range[1]) : 0;
  const total = range ? Number(range[3]) : declared;
  if (total > MAX_IMAGE_BYTES) {
    return void res.status(413).set('Connection', 'close').json({error: 'image over 5 MB'});
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_IMAGE_BYTES && !aborted) {
      aborted = true;
      res.status(413).set('Connection', 'close').json({error: 'image over 5 MB'});
      return;
    }
    if (res.locals.fault === 'dropMidBody' && size >= faults.dropAfterBytes && !aborted) {
      aborted = true;
      req.socket.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const final = imgPath(id, idx);
    fs.mkdirSync(path.dirname(final), {recursive: true});
    const body = Buffer.concat(chunks);

    if (fs.existsSync(final) && fs.statSync(final).size === total) {
      // Already complete (retry after a lost ack). Idempotent no-op.
      if (res.locals.fault === 'loseResponse') return void req.socket.destroy();
      return void res.json({ok: true, complete: true, received: total});
    }
    const part = partPath(id, idx);
    const have = received(id, idx);
    if (start > have) return void res.status(409).json({error: 'offset', offset: have});
    if (start < have) fs.truncateSync(part, start); // re-sent chunk: overwrite, don't double-append
    fs.appendFileSync(part, body);
    const now = start + body.length;
    const complete = now === total;
    if (complete) fs.renameSync(part, final);
    if (res.locals.fault === 'loseResponse') return void req.socket.destroy();
    res.json({ok: true, complete, received: now});
  });
});

app.get('/reports/:id/images/:idx', (req, res) => {
  const p = imgPath(req.params.id, Number(req.params.idx));
  if (!fs.existsSync(p)) return void res.sendStatus(404);
  res.type('image/jpeg').sendFile(p);
});

// ---- report commit (the "finalize" step) ----------------------------------
// A report becomes visible only once every one of its images is on disk.
// Replaying the same commit returns 200 again: nothing lands twice.
app.put('/reports/:id', express.json(), (req, res) => {
  const {id} = req.params;
  const {description, imageCount, createdAt} = req.body ?? {};
  if (
    !/^[\w-]{8,64}$/.test(id) ||
    typeof description !== 'string' ||
    !description.trim() ||
    !Number.isInteger(imageCount) ||
    imageCount < 1 ||
    imageCount > 5
  ) {
    return void res.status(400).json({error: 'invalid report'});
  }
  const missing = [...Array(imageCount).keys()].filter(i => !fs.existsSync(imgPath(id, i)));
  if (missing.length) return void res.status(409).json({error: 'images missing', missing});

  const existed = fs.existsSync(reportPath(id));
  if (!existed) {
    fs.writeFileSync(
      reportPath(id),
      JSON.stringify({id, description, imageCount, createdAt, receivedAt: new Date().toISOString()}),
    );
  }
  if (res.locals.fault === 'loseResponse') return void req.socket.destroy();
  res.status(existed ? 200 : 201).json({ok: true, duplicate: existed});
});

app.get('/reports', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const reports = fs
    .readdirSync(path.join(DATA, 'reports'))
    .map(f => JSON.parse(fs.readFileSync(path.join(DATA, 'reports', f), 'utf8')))
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    .map(r => ({
      ...r,
      images: [...Array(r.imageCount).keys()].map(i => ({
        url: `${base}/reports/${r.id}/images/${i}`,
        bytes: fs.statSync(imgPath(r.id, i)).size,
      })),
    }));
  res.json({reports});
});

app.listen(PORT, '0.0.0.0', () => console.log(`report server on :${PORT}, data in ${DATA}`));
