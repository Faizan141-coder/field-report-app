import ReactNativeBlobUtil from 'react-native-blob-util';
import {engine} from '../app/engine';

const fs = ReactNativeBlobUtil.fs;

/**
 * Wipes everything this app keeps on the device: the queue (including unsent reports), the
 * originals and prepared files, and picker/resizer leftovers in cache.
 * Does NOT touch the server: uploaded reports are the server's, not the phone's, to delete.
 */
export async function resetLocal(): Promise<void> {
  await engine.clearAll(); // aborts in-flight work, removes report records
  for (const dir of ['originals', 'prepared', 'reports']) {
    await fs.unlink(`${fs.dirs.DocumentDir}/${dir}`).catch(() => {});
  }
  const cached = await fs.ls(fs.dirs.CacheDir).catch(() => [] as string[]);
  for (const name of cached) {
    if (/\.(jpe?g|png|heic)$/i.test(name) || name.startsWith('rn_image_picker')) {
      await fs.unlink(`${fs.dirs.CacheDir}/${name}`).catch(() => {});
    }
  }
}
