/**
 * Save or share a file read from a computer (iOS, Android): the system
 * share sheet (expo-sharing), which holds Save Image / Save to Files.
 */
import * as Sharing from 'expo-sharing';
import type { CachedFile } from '../../fleet/file-cache';

export async function shareFile(file: CachedFile): Promise<void> {
  if (!file.uri) throw new Error('No local copy of the file to share.');
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(file.uri, {
    mimeType: file.mime || undefined,
    dialogTitle: file.name,
  });
}
