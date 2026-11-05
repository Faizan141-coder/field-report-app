import {AppRegistry, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import type {UploadEngine} from '../core/engine';
import type {Report} from '../core/types';

interface UploadServiceNative {
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
}
const native: UploadServiceNative | undefined =
  Platform.OS === 'android' ? NativeModules.UploadService : undefined;

const isPending = (reports: readonly Report[]) =>
  reports.some(r => r.phase === 'queued' || r.phase === 'uploading');

/**
 * Why this exists: a backgrounded Android app is frozen within seconds, and even if it isn't,
 * React Native pauses every JS timer when the activity pauses. `fetch` settles through
 * setTimeout, so uploads would hang mid-request. While any report is pending we run a foreground
 * service whose headless JS task keeps the process alive *and* the timers ticking.
 *
 * The engine knows nothing about this; it only publishes snapshots.
 */
export function keepAliveWhilePending(engine: UploadEngine): void {
  if (!native) return;
  let running = false;
  let askedForNotifications = false;
  let busy = false;
  let dirty = false;

  const sync = async () => {
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    try {
      do {
        dirty = false;
        const pending = isPending(engine.getSnapshot());
        if (pending && !running) {
          if (!askedForNotifications && Number(Platform.Version) >= 33) {
            askedForNotifications = true;
            // Without it the service still runs; only its notification is hidden.
            await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS').catch(() => {});
          }
          running = await native.start();
        } else if (!pending && running) {
          running = false;
          await native.stop();
        }
      } while (dirty);
    } finally {
      busy = false;
    }
  };

  engine.subscribe(() => void sync());
  void sync();
}

/**
 * The headless task the service launches. Its only job is to stay open (which keeps timers
 * running) until the queue is idle. Must be registered before the app component.
 */
export function registerKeepAliveTask(getEngine: () => Promise<UploadEngine>): void {
  AppRegistry.registerHeadlessTask('UploadKeepAlive', () => async () => {
    const engine = await getEngine(); // also loads the queue if the process was restarted
    await new Promise<void>(resolve => {
      const check = () => {
        if (!isPending(engine.getSnapshot())) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = engine.subscribe(check);
      check();
    });
  });
}
