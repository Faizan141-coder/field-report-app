import {AppState} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {UploadEngine} from '../core/engine';
import {SERVER_URL} from '../native/config';
import {fileStore} from '../native/fileStore';
import {createHttpApi} from '../native/httpApi';
import {imagePreparer} from '../native/imagePreparer';
import {keepAliveWhilePending} from '../native/keepAlive';
import {isOnline, onConnectivityChange} from '../native/network';

export const engine = new UploadEngine({
  store: fileStore,
  api: createHttpApi(SERVER_URL),
  preparer: imagePreparer,
  files: {remove: uri => ReactNativeBlobUtil.fs.unlink(uri.replace(/^file:\/\//, ''))},
  isOnline,
});

let started: Promise<void> | null = null;

/** Idempotent. Loads the queue from disk and wires "try again now" triggers. */
export function startEngine(): Promise<void> {
  started ??= (async () => {
    await engine.init();
    keepAliveWhilePending(engine);
    onConnectivityChange(online => online && engine.nudge());
    AppState.addEventListener('change', s => s === 'active' && engine.nudge());
  })();
  return started;
}

/** For the headless keep-alive task: the engine, once its queue has been loaded from disk. */
export async function getStartedEngine() {
  await startEngine();
  return engine;
}
