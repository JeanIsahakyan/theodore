import { useCallback, useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';

export type CheckboxRangeModifiers = { shiftKey: boolean };

export function useCheckboxRange<K extends string>({
  scopeKey,
  orderedKeys,
  onChange,
}: {
  scopeKey: string;
  orderedKeys: readonly K[];
  onChange: (keys: readonly K[], checked: boolean) => void;
}) {
  const anchor = useRef<{ scopeKey: string; key: K | null }>({
    scopeKey,
    key: null,
  });

  useEffect(() => {
    if (anchor.current.scopeKey !== scopeKey) {
      anchor.current = { scopeKey, key: null };
    } else if (
      anchor.current.key !== null &&
      !orderedKeys.includes(anchor.current.key)
    ) {
      anchor.current = { scopeKey, key: null };
    }
  }, [scopeKey, orderedKeys]);

  const activate = useCallback(
    (target: K, checked: boolean, { shiftKey }: CheckboxRangeModifiers) => {
      const targetIndex = orderedKeys.indexOf(target);
      if (targetIndex < 0) return;

      const current = anchor.current;
      const anchorKey = current.scopeKey === scopeKey ? current.key : null;
      const anchorIndex =
        anchorKey === null ? -1 : orderedKeys.indexOf(anchorKey);
      if (shiftKey && anchorIndex >= 0) {
        onChange(
          orderedKeys.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          ),
          checked,
        );
        anchor.current = { scopeKey, key: anchorKey };
      } else {
        onChange([target], checked);
        anchor.current = { scopeKey, key: target };
      }
    },
    [onChange, orderedKeys, scopeKey],
  );

  const resetAnchor = useCallback(() => {
    anchor.current = { scopeKey, key: null };
  }, [scopeKey]);

  return { activate, resetAnchor };
}

export function useCheckboxRangeEvents(
  onChange: (checked: boolean, modifiers: CheckboxRangeModifiers) => void,
) {
  const shiftClick = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const clearPending = useCallback(() => {
    shiftClick.current = false;
    if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    resetTimer.current = undefined;
  }, []);
  const onClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (event.detail === 0) return;
      shiftClick.current = event.shiftKey;
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(clearPending, 0);
    },
    [clearPending],
  );
  const onKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === ' ' || event.code === 'Space') clearPending();
    },
    [clearPending],
  );
  const onCheckboxChange = useCallback(
    (checked: boolean) => {
      const modifiers = { shiftKey: shiftClick.current };
      clearPending();
      onChange(checked, modifiers);
    },
    [clearPending, onChange],
  );
  useEffect(() => () => clearPending(), [clearPending]);

  return {
    onClickCapture,
    onBlurCapture: clearPending,
    onKeyDownCapture,
    onCheckboxChange,
  };
}
