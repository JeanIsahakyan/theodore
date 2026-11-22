/**
 * Picking files for a message (docs/mobile.md "Files"): the photo library,
 * the camera or the Files app, through Expo's pickers; a photo is
 * compressed before it is read (`planPhoto`: long side ≤ 2048 px, JPEG
 * 0.8, a small PNG kept). What comes out is ready to seal: bytes, a name,
 * a mime type, and a local URI the preview is drawn from.
 *
 * ```text
 * Photo library  expo-image-picker  launchImageLibraryAsync (several)  ─▶ compress ─▶ read
 * Camera         expo-image-picker  launchCameraAsync (one; not on web) ─▶ compress ─▶ read
 * File           expo-document-picker getDocumentAsync (several)        ─▶ read (an image: compress)
 * ```
 */
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import {
  PHOTO_QUALITY,
  isImageMime,
  mimeFromName,
  planPhoto,
} from '../../ui/attachments';

export type PickSource = 'library' | 'camera' | 'file';

/** A file ready to attach. */
export interface PickedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** Where the preview loads it from (the compressed copy for a photo). */
  uri: string;
}

const web = process.env.EXPO_OS === 'web';

/** The file's bytes: the Expo file API on a device, `fetch` on web. */
export async function readBytes(uri: string): Promise<Uint8Array> {
  if (web || /^(blob|data):/.test(uri)) {
    const res = await fetch(uri);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/** A picked image: compressed as planned, then read. */
async function photo(input: {
  uri: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number | null;
}): Promise<PickedFile> {
  const raw = input.size ?? (await readBytes(input.uri)).length;
  const plan = planPhoto({
    name: input.name,
    mime: input.mime,
    width: input.width,
    height: input.height,
    size: raw,
  });
  if (!plan.recode) {
    return {
      name: plan.name,
      mime: plan.mime,
      uri: input.uri,
      bytes: await readBytes(input.uri),
    };
  }
  const ctx = ImageManipulator.manipulate(input.uri);
  if (plan.resize) ctx.resize(plan.resize);
  const image = await ctx.renderAsync();
  try {
    const saved = await image.saveAsync({
      format: plan.format === 'png' ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: plan.format === 'png' ? 1 : PHOTO_QUALITY,
    });
    return {
      name: plan.name,
      mime: plan.mime,
      uri: saved.uri,
      bytes: await readBytes(saved.uri),
    };
  } finally {
    image.release();
  }
}

const photoName = (given: string | null | undefined, i: number): string =>
  given && given.trim() ? given : `photo-${Date.now().toString(36)}-${i}.jpg`;

/**
 * Opens the picker for `source` and returns what was picked, at most
 * `limit` files, each compressed and read. An empty list when cancelled.
 * Throws when a permission was refused.
 */
export async function pickFiles(
  source: PickSource,
  limit: number,
): Promise<PickedFile[]> {
  if (limit <= 0) return [];
  if (source === 'file') {
    const res = await DocumentPicker.getDocumentAsync({
      multiple: limit > 1,
      copyToCacheDirectory: true,
    });
    if (res.canceled) return [];
    const out: PickedFile[] = [];
    for (const a of res.assets.slice(0, limit)) {
      const mime = mimeFromName(a.name, a.mimeType);
      if (isImageMime(mime) && !/gif$/.test(mime)) {
        out.push(
          await photo({
            uri: a.uri,
            name: a.name,
            mime,
            width: 0,
            height: 0,
            size: a.size ?? null,
          }),
        );
      } else {
        out.push({
          name: a.name,
          mime,
          uri: a.uri,
          bytes: await readBytes(a.uri),
        });
      }
    }
    return out;
  }
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Camera access was not allowed.');
  }
  const res =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          quality: 1,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: limit > 1,
          selectionLimit: limit,
          quality: 1,
          // Metadata (location) stays on the phone.
          exif: false,
        });
  if (res.canceled) return [];
  const out: PickedFile[] = [];
  let i = 0;
  for (const a of res.assets.slice(0, limit)) {
    i += 1;
    const name = photoName(a.fileName, i);
    out.push(
      await photo({
        uri: a.uri,
        name,
        mime: mimeFromName(name, a.mimeType),
        width: a.width,
        height: a.height,
        size: a.fileSize ?? null,
      }),
    );
  }
  return out;
}
