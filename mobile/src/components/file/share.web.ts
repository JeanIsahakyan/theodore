/** Web: a download of the blob URL with the file's name. */
import type { CachedFile } from '../../fleet/file-cache';

export async function shareFile(file: CachedFile): Promise<void> {
  if (!file.uri || typeof document === 'undefined')
    throw new Error('No local copy of the file to download.');
  const a = document.createElement('a');
  a.href = file.uri;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
