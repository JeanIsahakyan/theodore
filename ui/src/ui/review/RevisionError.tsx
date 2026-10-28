/** What a diff shows when its revision failed to load: a short line, the
 *  error's first line (raw git stderr can run for screens) and a Retry. */
import { ArrowRotateRight } from '@gravity-ui/icons';
import { Btn } from '../bits';

/** The first non-empty line of an error message, trimmed — `''` if none. */
export function firstLine(error: string | undefined): string {
  return (
    (error ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

export function RevisionError({
  error,
  onRetry,
}: {
  error: string | undefined;
  onRetry: () => void;
}) {
  const detail = firstLine(error);
  return (
    <div
      role="alert"
      className="revision-error flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm"
    >
      <span className="font-medium">Couldn’t load this revision</span>
      {detail && (
        <span
          className="max-w-xl truncate font-mono text-xs text-muted"
          title={error}
        >
          {detail}
        </span>
      )}
      <Btn
        tone="secondary"
        icon={<ArrowRotateRight className="size-3.5" />}
        onPress={onRetry}
        className="mt-1"
      >
        Retry
      </Btn>
    </div>
  );
}
