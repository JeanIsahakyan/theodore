import { describe, expect, it } from 'vitest';
import { revision } from '../test/bigPr';
import { hunkIndex } from './GroupsPane';

describe('hunkIndex', () => {
  it('maps hunks to files, files to hunks in diff order, and counts lines', () => {
    const rev = revision();
    const { hunkFile, hunksOfPath, lineStats } = hunkIndex(rev);
    const f = rev.files[3]!;
    expect(hunksOfPath.get(f.path)).toEqual(f.hunks.map((h) => h.id));
    expect(hunkFile.get(f.hunks[1]!.id)).toBe(f.path);
    const h = f.hunks[0]!;
    expect(lineStats.get(h.id)).toEqual({
      add: h.lines.filter((l) => l.kind === 'add').length,
      del: h.lines.filter((l) => l.kind === 'del').length,
    });
  });
});
