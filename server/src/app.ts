import express, {NextFunction, Request, Response} from 'express';
import {NO_FAULTS, storeFromEnv} from './store';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const store = storeFromEnv();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res, next).catch(next);

export const app = express();

app.use((req, _res, next) => {
  console.log(new Date().toISOString().slice(11, 23), req.method, req.url);
  next();
});

app.get('/', (_req, res) => void res.json({service: 'field-report-server', ok: true}));
app.get('/health', (_req, res) => void res.json({ok: true}));

// ---- fault injection -------------------------------------------------------
// Applies to PUTs under /reports (image chunks + commit). `times` counts down per request;
// 0 = until cleared. See README "Making it fail".
app.post('/admin/faults', express.json(), wrap(async (req, res) => {
  const f = {...NO_FAULTS, ...req.body};
  await store.setFaults(f);
  console.log('faults ->', f);
  res.json(f);
}));
app.delete('/admin/faults', wrap(async (_req, res) => {
  await store.setFaults({...NO_FAULTS});
  res.json(NO_FAULTS);
}));
app.delete('/admin/reset', wrap(async (_req, res) => {
  await store.reset();
  res.json({ok: true});
}));

app.use('/reports', wrap(async (req, res, next) => {
  if (req.method !== 'PUT') return next();
  const faults = await store.getFaults();
  if (faults.latencyMs) await sleep(faults.latencyMs);
  const mode = await store.takeFault();
  res.locals.fault = mode;
  res.locals.dropAfterBytes = faults.dropAfterBytes;
  switch (mode) {
    case 'error500':
      return void res.status(500).json({error: 'injected 500'});
    case 'error503':
      return void res.status(503).set('Retry-After', '2').json({error: 'injected 503'});
    case 'reject400':
      return void res.status(400).json({error: 'injected 400'});
    case 'hang':
      return; // never answer; the client's stall watchdog gives up
    case 'drop':
      return void req.socket.destroy();
    default:
      return next();
  }
}));

// ---- images ----------------------------------------------------------------
// Resumable: a client sends `Content-Range: bytes start-end/total` chunks. A chunk that
// doesn't start at the server's offset gets 409 {offset}; GET .../status tells a client where
// to resume. Without Content-Range the body is the whole image.
app.get('/reports/:id/images/:idx/status', wrap(async (req, res) => {
  res.json(await store.imageStatus(req.params.id as string, Number(req.params.idx)));
}));

app.put('/reports/:id/images/:idx', (req, res, next) => {
  const id = req.params.id as string;
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
    if (res.locals.fault === 'dropMidBody' && size >= res.locals.dropAfterBytes && !aborted) {
      aborted = true;
      req.socket.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    void (async () => {
      const r = await store.putChunk(id, idx, start, total, Buffer.concat(chunks));
      if (r.kind === 'gap') return void res.status(409).json({error: 'offset', offset: r.offset});
      if (res.locals.fault === 'loseResponse') return void req.socket.destroy();
      res.json({ok: true, complete: r.complete, received: r.received});
    })().catch(next);
  });
});

app.get('/reports/:id/images/:idx', wrap(async (req, res) => {
  const buf = await store.readImage(req.params.id as string, Number(req.params.idx));
  if (!buf) return void res.sendStatus(404);
  res.type('image/jpeg').send(buf);
}));

// ---- report commit (the "finalize" step) ----------------------------------
// A report becomes visible only once every one of its images is stored. Replaying the same
// commit returns 200 again: nothing lands twice.
app.put('/reports/:id', express.json(), wrap(async (req, res) => {
  const id = req.params.id as string;
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
  const sizes = await Promise.all([...Array(imageCount).keys()].map(i => store.imageSize(id, i)));
  const missing = sizes.flatMap((s, i) => (s === undefined ? [i] : []));
  if (missing.length) return void res.status(409).json({error: 'images missing', missing});

  const existed = await store.hasReport(id);
  if (!existed) {
    await store.saveReport({id, description, imageCount, createdAt, receivedAt: new Date().toISOString()});
  }
  if (res.locals.fault === 'loseResponse') return void req.socket.destroy();
  res.status(existed ? 200 : 201).json({ok: true, duplicate: existed});
}));

app.get('/reports', wrap(async (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const base = `${proto}://${req.get('host')}`;
  const docs = await store.listReports();
  const reports = await Promise.all(
    docs.map(async r => ({
      ...r,
      images: await Promise.all(
        [...Array(r.imageCount).keys()].map(async i => ({
          url: `${base}/reports/${r.id}/images/${i}`,
          bytes: (await store.imageSize(r.id, i)) ?? 0,
        })),
      ),
    })),
  );
  res.json({reports});
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({error: 'server error'});
});
