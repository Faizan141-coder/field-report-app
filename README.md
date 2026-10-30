# Field Report

A React Native (bare CLI, TypeScript) app for filing photo reports from a place with a bad network: a description plus 1–5 photos, queued on the device and delivered unattended, exactly once.

```
app/      React Native app (Android first; iOS project present, untested)
server/   Express backend with on-demand fault injection
```

## Run it

Requirements: Node 22+, JDK 17, Android SDK, an emulator or device.

```bash
# 1. backend (terminal 1)
cd server && npm install && npm start          # http://localhost:4000, data in server/data

# 2. app (terminal 2)
cd app && npm install
adb reverse tcp:4000 tcp:4000                  # lets the phone reach the server as "localhost"
npx react-native run-android
```

The server URL is one constant: `app/src/native/config.ts`.

### Headless (no UI, no device)

The upload engine runs in plain Node against the real server. It checksums every byte end to end:

```bash
cd server && PORT=4100 DATA_DIR=/tmp/frs-headless npm start     # terminal 1
cd app && npm run headless                                      # terminal 2
```

Scenarios: baseline; lost acks, dropped sockets, mid-body drops, 500s and hangs with a simulated force-quit in the middle; offline then reconnect; a permanent 400 that must not be retried.

## Making it fail

The server injects faults on `PUT` requests (image chunks and the report commit):

```bash
curl -X POST localhost:4000/admin/faults -H 'content-type: application/json' \
  -d '{"mode":"loseResponse","times":3}'
curl -X DELETE localhost:4000/admin/faults       # clear
```

| mode | what the client sees | expected behaviour |
|---|---|---|
| `error500` / `error503` | 5xx (503 has `Retry-After`) | retried with backoff |
| `reject400` | 400 | **not** retried; "Needs attention" |
| `hang` | request never answered | stall watchdog aborts, retried |
| `drop` | socket destroyed immediately | retried |
| `dropMidBody` (+`dropAfterBytes`) | connection dies partway through a chunk | resumes from the server's offset |
| `loseResponse` | the write is stored, then the socket dies | retry is a no-op; no duplicate |

Extra knobs: `latencyMs` (added to every write), `times` (how many requests the fault applies to; `0` = until cleared). `DELETE /admin/reset` wipes the server's data. A 413 is returned for anything declaring more than 5 MB.

For a slow link use the emulator's network speed setting (Extended controls → Cellular → network type GSM/EDGE) or `latencyMs`.

## How delivery works

1. **Saved first.** "Save report" copies the photos into app-private storage and writes the report to disk. Only then does the screen close. Nothing waits on the network.
2. **One worker, one report at a time.** On 2G, parallel uploads only make every upload slower and every failure likelier.
3. **Resumable images.** Each photo is sent as 64 KB `Content-Range` slices. Before sending, the client asks the server how many bytes it has and continues from there; a connection that dies costs at most one slice, not the whole photo.
4. **Commit.** After all images are acknowledged, one `PUT /reports/:id` commits the report. The server refuses (`409` + missing indexes) if any image isn't there, so a report is never visible half-uploaded.
5. **Idempotent by construction.** The report id is generated on the device. Re-sending a slice, an image or the commit is always safe and never creates a second report. A lost response is therefore handled the same as a lost request: ask again.
6. **State after every step.** The report file is rewritten (atomically) after preparing each image, after each image is acknowledged, and after the commit. A kill at any point resumes from the last finished step; reports left `uploading` by a kill are re-queued on launch.

### What is retried

| failure | treatment |
|---|---|
| no network, timeouts, stalls, dropped connections, 5xx, 408, 429 | retry forever with exponential backoff (2 s → 5 min cap, jittered, honours `Retry-After`); never gives up on its own |
| other 4xx | **not retried**; report goes to "Needs attention" with Try again / Discard |
| 413 | recompress harder and retry, up to a bounded number of times, then "Needs attention" |
| 409 on commit | server lacks some images; re-send those |

Timeouts are **stall-based** (no progress for 30 s), not whole-request: a healthy 2G upload can take minutes, a dead one makes no progress.

## Images

Originals (an 18 MB camera file is fine) are decoded, scaled and re-encoded **natively** by `react-native-image-resizer`, so the JS thread never touches pixels. EXIF orientation is baked in. The first attempt is 2048 px long edge at JPEG q80 (typically well under 2 MB, still sharp); if the result is above 90 % of the 5 MB cap it steps down a ladder (1600/70 → 1280/60 → 1024/50 → 800/40). The app never sends a file over the cap; the 413 path is a second line of defence.

## Interface decisions

- The home banner answers one question: *is my work safe, moving, or lost?* (red needs attention / amber saved & waiting / blue uploading / green all uploaded).
- **"Uploaded" appears only after the server commits.** Until then the wording is "Saved on this device · not uploaded".
- Two tabs on purpose: *On this device* (the local queue) and *On the server* (fetched from the server, never reconstructed from local state).
- Permissions are never cached. Every press asks the OS again, so granting camera/photo access from Settings works without restarting. On Android the system camera and photo-picker intents need no runtime permission at all.

### Reset

"Reset this device" deletes the local queue **including reports not yet uploaded**, plus all copied originals, prepared images and picker/cache leftovers. It names how many unsent reports will be lost before it proceeds. It does **not** touch the server: a phone should not be able to delete what the server holds. (For dev, `DELETE /admin/reset` wipes server data.)

## Decisions & trade-offs

- **Hand-rolled queue, not a library.** The guarantees are the point; the engine is ~300 lines with every side effect behind a port (`store`, `api`, `preparer`, `files`), so it runs unchanged in Node (the headless harness) and in RN.
- **One JSON file per report**, atomic write (tmp → unlink → move; a crash in the gap is repaired on load). Chosen over SQLite: a handful of small records, no native dependency, and one corrupt file can't take others down.
- **Own backend** rather than S3/Firebase, because resumable chunks, a commit step that refuses incomplete reports, and fault injection were easier to get right than to bolt onto a vendor SDK.

## Not done / known gaps

*(to be completed after verification)*
