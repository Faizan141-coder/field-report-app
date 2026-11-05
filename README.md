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
npx react-native run-android                   # debug (needs Metro)
# or a standalone build that needs no Metro, best for kill/airplane-mode tests:
npx react-native run-android --mode release
```

The server URL is one constant: `app/src/native/config.ts`.

### Run on an iPhone (not yet verified by me)

The iOS project is set up but **I have not been able to build it** (the machine I developed on has no Xcode), so treat this as a best-effort recipe. It needs a Mac with Xcode and an iPhone on the **same Wi-Fi** as the Mac.

```bash
# 1. Xcode from the App Store, opened once; then:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch

# 2. dependencies
cd app && npm install
cd ios && pod install        # or: bundle install && bundle exec pod install

# 3. point the app at your Mac: edit IOS_SERVER_HOST in app/src/native/config.ts to
echo "$(scutil --get LocalHostName).local"      # e.g. Faizans-MacBook-Air.local (don't commit it)

# 4. backend, listening on all interfaces (it already does)
cd ../../server && npm install && npm start
```

Then in Xcode: open `app/ios/FieldReport.xcworkspace` → target *FieldReport* → *Signing & Capabilities* → pick your **Team** (a free Apple ID "Personal Team" works) and change the **Bundle Identifier** to something unique (e.g. `com.yourname.fieldreport`). Plug in the iPhone, unlock it, tap *Trust*, and enable *Settings → Privacy & Security → Developer Mode* (it restarts). Pick the phone as the run destination.

For kill / airplane-mode tests use a build that doesn't need Metro: *Product → Scheme → Edit Scheme… → Run → Build Configuration: **Release***, then ⌘R. First launch: *Settings → General → VPN & Device Management* → trust your developer profile, then allow the **Local Network** prompt in the app (without it the phone can't reach the Mac). A free-account build expires after 7 days.

What differs from Android: there is **no background service on iOS**, so uploads pause roughly 30 seconds after the app is backgrounded and resume when it is reopened (nothing is lost); and the camera and photo permission prompts are real, so you can deny them and exercise the *Open Settings* path (grant it in Settings and come back; no restart needed).

### Hosted backend (no cable needed)

Release builds of the app talk to `https://field-report-server.onrender.com`; debug builds still use
`localhost:4000` (see `app/src/native/config.ts`). The server is deployed from `render.yaml`
(Render, Docker, free plan): New -> Blueprint -> pick this repo.

- The free plan sleeps after ~15 min idle (first request ~30 s; the app just retries) and its disk
  is wiped on restart/redeploy, so uploaded reports are not durable. Fine for a demo.
- Fault injection against the hosted server:
  `curl -X POST https://field-report-server.onrender.com/admin/faults -H 'content-type: application/json' -d '{"mode":"dropMidBody","times":6,"dropAfterBytes":20000}'`
  (clear with `curl -X DELETE .../admin/faults`; inspect with `curl .../reports`).

## Headless (no UI, no device)

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

For a slow link use the emulator's network speed setting (Extended controls → Cellular → network type GSM/EDGE, or start it with `-netspeed edge -netdelay none`) or `latencyMs`.

### Walkthrough: the assessment's main scenario

```bash
# backend + app as above, release build installed
adb shell cmd connectivity airplane-mode enable      # 1. airplane mode on
# 2. in the app: create three reports, one with five photos (use "From gallery")
adb shell am force-stop com.fieldreport              # 3. force-quit
adb shell am start -n com.fieldreport/.MainActivity  # 4. reopen: all three still "Saved on this device"

curl -X POST localhost:4000/admin/faults -H 'content-type: application/json' \
  -d '{"mode":"dropMidBody","times":6,"dropAfterBytes":20000}'   # 5. the link keeps dying mid-upload
adb shell cmd connectivity airplane-mode disable     # 6. connectivity returns; no input needed

curl -s localhost:4000/reports | python3 -m json.tool   # 7. each report exactly once, every image present
curl -X DELETE localhost:4000/admin/faults
```

If the emulator doesn't regain a network after leaving airplane mode, restart it (`adb emu kill`, then start it again); that is an emulator quirk, not the app.

Other things to try: `hang` (the app should abandon the request after ~30 s of no progress and retry), `reject400` (the report should stop at "Needs attention" and *not* retry), a sixth photo (blocked at the picker), zero photos or a blank description (Save stays disabled).

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

## Background uploads (Android)

A backgrounded Android app is frozen within seconds, and React Native additionally **pauses every JS timer** when the activity pauses. `fetch` settles through `setTimeout`, so without help an in-flight request hangs until the app is foregrounded (I reproduced exactly that on an emulator). While any report is queued or uploading, the app therefore runs a **foreground service** (`UploadForegroundService`, a `HeadlessJsTaskService`): the notification keeps the process alive, and the open headless task keeps the timers ticking. The engine itself knows nothing about this; `app/src/native/keepAlive.ts` just watches its snapshots and starts or stops the service. When nothing is pending the task ends, the service stops itself and the notification disappears.

- Android 13+ asks for the notification permission the first time work is pending. **If it is denied the service still runs** (only its notification is hidden).
- Force-stopping the app from Settings kills the service too; the next launch resumes from disk.
- Not implemented: iOS background transfers.

## What has been verified, and how

Headless (`npm run headless`, real engine, real server, MD5 of every image): exactly-once, byte-identical delivery through lost acks, dropped sockets, mid-body drops, 500s, hangs and a simulated force-quit; offline holds and reconnect delivers; a 400 is not retried.

By hand on an Android 15 arm64 emulator with a **release** build (`adb root` was used to inspect the app's private files and the server's data directory afterwards):

| scenario | result |
|---|---|
| blank / whitespace-only description, zero photos | Save stays disabled with a hint; the description is trimmed |
| sixth photo | blocked: both photo buttons disable with an explanation; the picker is limited to the free slots |
| 3 reports (1, 3 and 5 photos) composed in airplane/no-data mode, force-quit, reopened | all three still "Saved on this device"; originals and one JSON file per report on disk; nothing on the server |
| connectivity returns with the link dropping mid-chunk twice (+400 ms/slice) | 3 reports on the server exactly once, 9 valid images; request count = expected slices + exactly the 2 retries |
| force-quit **three times mid-upload** (18.3 MB original in the set) | the server kept `.part` files at 1088 KB, then 256 KB, then 128 KB; each relaunch resumed from the server's offset; final state: each report once, every image valid, none over the cap, no `.part` left. The 18.3 MB original arrived as ~1.4 MB |
| server returns 400 | "Needs attention" after exactly one request, no retries in the next 20 s; *Try again* with the fault still on fails once more; after clearing it the report uploads |
| server hangs on a write | the stall watchdog abandoned it after ~30 s and the retry succeeded |
| 503 + `Retry-After: 2` three times | retries at +2.1 s, +3.0 s, +4.2 s, then success |
| connectivity cut mid-pass with two reports queued | the second report was not started while offline; both delivered after reconnect |
| *On the server* tab | real thumbnails fetched from the server, byte totals; with the server down: "Couldn't reach the server" and a note that saved reports are still on the device |
| Reset | *Cancel* changes nothing; confirming leaves zero files in app storage and the server untouched (11 reports before and after) |
| camera (emulator virtual camera) | photo arrives upright (orientation baked into pixels); backing out of the camera returns to compose with the draft intact |
| app backgrounded (on the launcher) while uploading | the whole report uploaded and committed in the background; the service and its notification then went away |
| force-quit mid-upload with the service running | no crash, no lingering service; relaunch resumed and finished exactly once |

## Not done / known gaps

Said plainly, in rough order of how much I'd worry:

- **Not run on a physical device or a real 2G link.** The emulator reaches the server through `adb reverse`, which bypasses the emulated network, so link speed is simulated server-side (`latencyMs`) and failures are injected rather than physical. Chunk size (64 KB) and the stall timeout (30 s) are educated guesses.
- **Notification-permission and Doze behaviour** beyond the cases above (OEM battery optimisers, Android 14's six-hour `dataSync` limit) are untested.
- **Camera / photo "permission refused, granted later from Settings"** could not be exercised on Android: the system camera and photo-picker intents need no runtime permission, so there is nothing to refuse. The code re-asks on every press and shows an *Open Settings* notice if the OS reports `permission` (this is the iOS case, which I never built).
- **A draft in progress is not persisted.** Force-quit before pressing Save and the draft is gone; saved reports are safe.
- **"Uploading 0 of 5" covers the preparing step too**; resizing a large original takes a moment and the UI doesn't distinguish it from sending.
- **Thumbnails of uploaded reports** are placeholders locally (local files are deleted after commit); the *On the server* tab shows the real images.
- **The Reset link sits at the bottom of the list**, so with many reports it is a scroll away. Deliberate for a destructive action, but easy to miss.
- **Dev transport only.** Plain HTTP to `localhost` over `adb reverse`; the network security config permits cleartext to `localhost`, `127.0.0.1` and `10.0.2.2` only. A real deployment needs HTTPS and an authenticated backend (no login by design here).
- **iOS:** the project exists, the usage strings and local-network access are configured and there is a recipe above, but I never built or run it (no Xcode on my machine). The Android foreground service has no iOS counterpart.
- **No unit-test suite** beyond the headless scenarios; I preferred verifying the delivery guarantees end to end.

## With another day

1. Persist the compose draft; WorkManager as a second line of defence if the OS kills the process.
2. iOS background transfers (`URLSession` background configuration).
3. A distinct "Preparing photos" state and per-image progress.
4. Hand-run the full fault matrix on a physical device on a throttled network; tune chunk size and stall timeout from real numbers.
5. Content-hash the images so the server can detect a corrupted chunk, not just a missing one.
