import ImageResizer from '@bam.tech/react-native-image-resizer';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {UploadError} from '../core/errors';
import {ImagePreparer, MAX_IMAGE_BYTES} from '../core/types';

const fs = ReactNativeBlobUtil.fs;
const OUT_DIR = `${fs.dirs.DocumentDir}/prepared`;

/** Stay well under the hard 5 MB ceiling: also keeps 2G uploads humane. */
const TARGET_BYTES = Math.floor(MAX_IMAGE_BYTES * 0.9);

/** Long-edge px / JPEG quality, getting harder with each step. Step 0 is "still worth looking at". */
const LADDER = [
  {edge: 2048, quality: 80},
  {edge: 1600, quality: 70},
  {edge: 1280, quality: 60},
  {edge: 1024, quality: 50},
  {edge: 800, quality: 40},
];

/**
 * Decoding, scaling and encoding all happen in native code, off the JS thread.
 * EXIF orientation is baked into the pixels so the result displays upright everywhere.
 */
export const imagePreparer: ImagePreparer = {
  async prepare(originalUri, step) {
    await fs.mkdir(OUT_DIR).catch(() => {});
    for (let s = Math.min(step, LADDER.length - 1); s < LADDER.length; s++) {
      const {edge, quality} = LADDER[s];
      let res;
      try {
        res = await ImageResizer.createResizedImage(
          originalUri, edge, edge, 'JPEG', quality, 0, OUT_DIR, false,
          {mode: 'contain', onlyScaleDown: true},
        );
      } catch (e) {
        throw new UploadError('permanent', `Could not process photo: ${(e as Error).message}`);
      }
      if (res.size <= TARGET_BYTES) return {uri: res.uri, bytes: res.size};
      await fs.unlink(res.path).catch(() => {});
    }
    throw new UploadError('permanent', 'Photo could not be reduced under the size limit');
  },
};
