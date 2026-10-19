/**
 * The image-diff file block (plan "image diff"): before/after for a
 * changed png/jpg/jpeg/gif/webp/svg/ico, in side-by-side, swipe or onion
 * skin mode, with dimensions and the size change — GitHub's own image diff
 * UI, ported to Theodore's own commands (`get_blob`).
 */
import { useEffect, useState } from 'react';
import { Card, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { FileCode } from '@gravity-ui/icons';
import type { BlobResponse, FileDiff, PrId, Sha } from '../../gen/contract';
import { api, CommandFailure } from '../../core/api';
import { Spinner } from '../bits';
import {
  type ImageDiffMode,
  clampPercent,
  formatBytes,
  formatSizeDelta,
} from './imageDiff';

type SideState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; blob: BlobResponse };

/** `key` identifies the exact request (pr, path, side and the open
 *  revision — a rebase or a push changes which bytes `path` resolves to
 *  without changing `path` itself).
 *
 *  `loading` is derived, not set: the result is tagged with the key it
 *  answers, so a path/side/rev change shows `loading` on the next render
 *  for free, without an effect calling `setState` synchronously to reset
 *  it (`react-hooks/set-state-in-effect`). */
function useBlob(
  pr: PrId,
  path: string,
  side: 'base' | 'head',
  enabled: boolean,
  key: string,
): SideState {
  const [result, setResult] = useState<{
    key: string;
    state: SideState;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api
      .getBlob({ pr, path, side })
      .then((blob) => {
        if (live) setResult({ key, state: { status: 'ready', blob } });
      })
      .catch((e: unknown) => {
        if (!live) return;
        setResult({
          key,
          state: {
            status: 'error',
            message: e instanceof CommandFailure ? e.message : String(e),
          },
        });
      });
    return () => {
      live = false;
    };
  }, [key, enabled, pr, path, side]);

  if (!enabled) return { status: 'disabled' };
  if (!result || result.key !== key) return { status: 'loading' };
  return result.state;
}

/** A checkerboard behind a possibly-transparent image, so a transparent
 *  PNG/webp/SVG doesn't just look blank against the card background. */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'repeating-conic-gradient(var(--checker, #8884) 0% 25%, transparent 0% 50%)',
  backgroundSize: '16px 16px',
};

function dataUrl(blob: BlobResponse): string {
  return `data:${blob.mime};base64,${blob.base64}`;
}

function Dims({
  dims,
  bytes,
}: {
  dims: { w: number; h: number } | null;
  bytes: number;
}) {
  return (
    <span className="dims text-xs text-muted">
      {dims ? `${dims.w}×${dims.h} · ` : ''}
      {formatBytes(bytes)}
    </span>
  );
}

function Img({
  blob,
  alt,
  onDims,
  className = '',
  style,
}: {
  blob: BlobResponse;
  alt: string;
  onDims: (d: { w: number; h: number }) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <img
      src={dataUrl(blob)}
      alt={alt}
      className={`max-w-full ${className}`}
      style={{ ...CHECKERBOARD, ...style }}
      onLoad={(e) =>
        onDims({
          w: e.currentTarget.naturalWidth,
          h: e.currentTarget.naturalHeight,
        })
      }
    />
  );
}

function SideError({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center p-8 text-sm text-muted">
      Couldn't load this image: {message}
    </div>
  );
}

export function ImageDiffCard({
  pr,
  base,
  rev,
  file,
}: {
  pr: PrId;
  base: Sha;
  rev: Sha;
  file: FileDiff;
}) {
  const revKey = `${base}:${rev}`;
  const hasBase = file.status !== 'added';
  const hasHead = file.status !== 'deleted';
  const basePath = file.old_path ?? file.path;
  const baseKey = `${pr}:${basePath}:base:${revKey}`;
  const headKey = `${pr}:${file.path}:head:${revKey}`;

  const baseState = useBlob(pr, basePath, 'base', hasBase, baseKey);
  const headState = useBlob(pr, file.path, 'head', hasHead, headKey);

  // Dims are tagged with the key of the image they were measured from, the
  // same way `useBlob`'s result is — so a path/revision change shows no
  // (stale) dims on the next render without an effect resetting state.
  const [baseDimsEntry, setBaseDimsEntry] = useState<{
    key: string;
    dims: { w: number; h: number };
  } | null>(null);
  const [headDimsEntry, setHeadDimsEntry] = useState<{
    key: string;
    dims: { w: number; h: number };
  } | null>(null);
  const baseDims = baseDimsEntry?.key === baseKey ? baseDimsEntry.dims : null;
  const headDims = headDimsEntry?.key === headKey ? headDimsEntry.dims : null;
  const setBaseDims = (dims: { w: number; h: number }) =>
    setBaseDimsEntry({ key: baseKey, dims });
  const setHeadDims = (dims: { w: number; h: number }) =>
    setHeadDimsEntry({ key: headKey, dims });

  const [mode, setMode] = useState<ImageDiffMode>('side-by-side');
  const [pct, setPct] = useState(50);

  const baseBlob = baseState.status === 'ready' ? baseState.blob : null;
  const headBlob = headState.status === 'ready' ? headState.blob : null;
  const bothSides = hasBase && hasHead;
  const loading =
    (hasBase && baseState.status === 'loading') ||
    (hasHead && headState.status === 'loading');

  const sizeDelta = formatSizeDelta(
    baseBlob?.bytes ?? null,
    headBlob?.bytes ?? null,
  );

  return (
    <Card className="file image-diff mb-4 gap-0 overflow-hidden p-0">
      <header className="file-h flex items-center gap-3 border-b border-separator bg-surface px-4 py-2.5 text-sm">
        <FileCode className="size-4 shrink-0 text-muted" />
        <span
          className="min-w-0 truncate font-mono text-[13px]"
          dir="rtl"
          title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
        >
          <span dir="ltr">
            {file.old_path && (
              <span className="text-muted line-through decoration-muted/60">
                {file.old_path}
              </span>
            )}
            {file.old_path && <span className="px-1.5 text-muted">→</span>}
            <span className="font-medium">{file.path}</span>
          </span>
        </span>
        {sizeDelta && (
          <span className="size-delta shrink-0 whitespace-nowrap text-xs text-muted">
            {sizeDelta}
          </span>
        )}
        <span className="flex-1" />
        {bothSides && baseBlob && headBlob && (
          <ToggleButtonGroup
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            aria-label="Image diff mode"
            className="image-diff-mode shrink-0"
            selectedKeys={new Set([mode])}
            onSelectionChange={(k) => setMode([...k][0] as ImageDiffMode)}
          >
            <ToggleButton id="side-by-side">Side by side</ToggleButton>
            <ToggleButton id="swipe">
              <ToggleButtonGroup.Separator />
              Swipe
            </ToggleButton>
            <ToggleButton id="onion">
              <ToggleButtonGroup.Separator />
              Onion skin
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </header>
      <div className="image-diff-body p-4">
        {loading && (
          <div className="flex items-center justify-center p-8">
            <Spinner />
          </div>
        )}
        {!loading && baseState.status === 'error' && (
          <SideError message={baseState.message} />
        )}
        {!loading && headState.status === 'error' && (
          <SideError message={headState.message} />
        )}
        {!loading && !bothSides && headBlob && (
          <figure className="flex flex-col items-center gap-2">
            <Img blob={headBlob} alt={file.path} onDims={setHeadDims} />
            <Dims dims={headDims} bytes={headBlob.bytes} />
          </figure>
        )}
        {!loading && !bothSides && baseBlob && (
          <figure className="flex flex-col items-center gap-2">
            <Img blob={baseBlob} alt={file.path} onDims={setBaseDims} />
            <Dims dims={baseDims} bytes={baseBlob.bytes} />
          </figure>
        )}
        {!loading && bothSides && baseBlob && headBlob && (
          <>
            {mode === 'side-by-side' && (
              <div className="grid grid-cols-2 gap-4">
                <figure className="flex flex-col items-center gap-2">
                  <span className="text-xs font-medium text-muted">before</span>
                  <Img
                    blob={baseBlob}
                    alt={`${file.path} before`}
                    onDims={setBaseDims}
                  />
                  <Dims dims={baseDims} bytes={baseBlob.bytes} />
                </figure>
                <figure className="flex flex-col items-center gap-2">
                  <span className="text-xs font-medium text-muted">after</span>
                  <Img
                    blob={headBlob}
                    alt={`${file.path} after`}
                    onDims={setHeadDims}
                  />
                  <Dims dims={headDims} bytes={headBlob.bytes} />
                </figure>
              </div>
            )}
            {mode === 'swipe' && (
              <div className="flex flex-col items-center gap-3">
                <div className="relative inline-block max-w-full overflow-hidden">
                  <Img
                    blob={headBlob}
                    alt={`${file.path} after`}
                    onDims={setHeadDims}
                  />
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ width: `${pct}%` }}
                  >
                    <Img
                      blob={baseBlob}
                      alt={`${file.path} before`}
                      onDims={setBaseDims}
                      className="max-w-none"
                    />
                  </div>
                  <div
                    className="absolute top-0 bottom-0 w-px bg-accent"
                    style={{ left: `${pct}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={pct}
                  aria-label="Swipe position"
                  onChange={(e) => setPct(clampPercent(Number(e.target.value)))}
                  className="w-full max-w-sm"
                />
                <span className="text-xs text-muted">
                  before {baseDims ? `${baseDims.w}×${baseDims.h}` : ''} → after{' '}
                  {headDims ? `${headDims.w}×${headDims.h}` : ''}
                </span>
              </div>
            )}
            {mode === 'onion' && (
              <div className="flex flex-col items-center gap-3">
                <div className="relative inline-block max-w-full">
                  <Img
                    blob={baseBlob}
                    alt={`${file.path} before`}
                    onDims={setBaseDims}
                  />
                  <Img
                    blob={headBlob}
                    alt={`${file.path} after`}
                    onDims={setHeadDims}
                    className="absolute inset-0"
                    style={{ opacity: pct / 100 }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={pct}
                  aria-label="Onion skin opacity"
                  onChange={(e) => setPct(clampPercent(Number(e.target.value)))}
                  className="w-full max-w-sm"
                />
                <span className="text-xs text-muted">
                  before {baseDims ? `${baseDims.w}×${baseDims.h}` : ''} → after{' '}
                  {headDims ? `${headDims.w}×${headDims.h}` : ''} · opacity{' '}
                  {pct}%
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
