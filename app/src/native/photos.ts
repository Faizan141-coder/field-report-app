import {Linking} from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {launchCamera, launchImageLibrary, ImagePickerResponse} from 'react-native-image-picker';

export type PickResult =
  | {ok: true; uris: string[]}
  | {ok: false; reason: 'cancelled'}
  | {ok: false; reason: 'permission'; what: 'camera' | 'photos'}
  | {ok: false; reason: 'error'; message: string};

function toResult(res: ImagePickerResponse, what: 'camera' | 'photos'): PickResult {
  if (res.didCancel) return {ok: false, reason: 'cancelled'};
  if (res.errorCode === 'permission') return {ok: false, reason: 'permission', what};
  if (res.errorCode) {
    return {
      ok: false,
      reason: 'error',
      message:
        res.errorCode === 'camera_unavailable'
          ? 'No camera available on this device.'
          : res.errorMessage ?? 'Could not get the photo.',
    };
  }
  const uris = (res.assets ?? []).map(a => a.uri).filter((u): u is string => !!u);
  return uris.length ? {ok: true, uris} : {ok: false, reason: 'cancelled'};
}

// Permission is requested by the OS on every launch, never cached by us, so granting it in
// Settings and coming back works without a restart. Android's system camera/photo-picker
// intents need no runtime permission at all.
export async function takePhoto(): Promise<PickResult> {
  return toResult(await launchCamera({mediaType: 'photo', saveToPhotos: false, cameraType: 'back'}), 'camera');
}

export async function pickFromGallery(limit: number): Promise<PickResult> {
  return toResult(
    await launchImageLibrary({mediaType: 'photo', selectionLimit: Math.max(1, limit)}),
    'photos',
  );
}

export const openSettings = () => Linking.openSettings();

const ORIGINALS = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/originals`;
export const originalsDir = ORIGINALS;

/**
 * Copy picks into app-private storage under the report's own folder. Picker/cache URIs can be
 * purged by the OS; nothing queued may point at them.
 */
export async function stagePhotos(reportId: string, uris: string[]): Promise<string[]> {
  const fs = ReactNativeBlobUtil.fs;
  const dir = `${ORIGINALS}/${reportId}`;
  await fs.mkdir(dir);
  const out: string[] = [];
  for (let i = 0; i < uris.length; i++) {
    const dest = `${dir}/${i}.jpg`;
    await fs.cp(uris[i].replace(/^file:\/\//, ''), dest);
    out.push(`file://${dest}`);
  }
  return out;
}

export function newReportId(): string {
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${Date.now().toString(36)}-${rnd()}${rnd()}`;
}
