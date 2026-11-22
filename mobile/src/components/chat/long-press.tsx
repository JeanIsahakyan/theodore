/**
 * Long-press a message (iOS, Android) for its menu (docs/mobile.md "Select
 * text"; items: `src/ui/messageMenu.ts`): Copy the whole text, Select
 * text (the sheet), a row's own actions.
 *
 * ```text
 * iOS      ActionSheetIOS   Copy · Select text · … · Cancel
 * Android  Alert            Copy · Select text (· one more)
 * Select text ─▶ useSheet('text'): iOS a formSheet route, Android a
 *                ModalBottomSheet in place, the text in src/state/selectText
 * ```
 *
 * The text under it isn't `selectable` on the phone: that would take the
 * long press (and copies only the whole message on iOS). Tapping through
 * to a row or a file link still works: the children get the tap, this gets
 * the hold. A drag is the list's (or the drawer's) before the hold lands.
 */
import { useCallback, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable } from 'react-native';
import { setSelectText } from '../../state/selectText';
import {
  CANCEL,
  COPY,
  KIND_TITLE,
  SELECT_TEXT,
  messageMenuItems,
  type MenuAction,
  type MessageKind,
} from '../../ui/messageMenu';
import { copied, copyText } from '../settings/feedback';
import { useSheet } from '../pickers/sheet-host';

export interface LongPressMenuProps {
  /** The whole text Copy puts on the clipboard and the sheet shows. */
  text: string;
  kind: MessageKind;
  /** A row's own actions, after Copy and Select text. */
  extras?: readonly MenuAction[];
  onExtra?: (id: string) => void;
  children: ReactNode;
  disabled?: boolean;
}

export function LongPressMenu({
  text,
  kind,
  extras,
  onExtra,
  children,
  disabled,
}: LongPressMenuProps) {
  const sheet = useSheet('text');
  const pick = useCallback(
    (id: string) => {
      if (id === COPY.id) {
        void copyText(text).then((ok) => ok && copied());
      } else if (id === SELECT_TEXT.id) {
        setSelectText(text, kind);
        sheet.open();
      } else if (id !== CANCEL.id) {
        onExtra?.(id);
      }
    },
    [text, kind, sheet, onExtra],
  );

  const show = useCallback(() => {
    const items = messageMenuItems(kind, text, extras);
    if (!items.length) return;
    if (Platform.OS === 'ios') {
      const options = [...items.map((a) => a.label), CANCEL.label];
      const destructive = items.findIndex((a) => a.destructive);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: KIND_TITLE[kind],
          options,
          cancelButtonIndex: options.length - 1,
          ...(destructive >= 0
            ? { destructiveButtonIndex: destructive }
            : null),
        },
        (i) => {
          const chosen = items[i];
          if (chosen) pick(chosen.id);
        },
      );
      return;
    }
    // An alert holds three buttons: the two of ours and one extra.
    Alert.alert(
      KIND_TITLE[kind],
      undefined,
      [
        ...items.slice(0, 3).map((a) => ({
          text: a.label,
          onPress: () => pick(a.id),
          ...(a.destructive ? { style: 'destructive' as const } : null),
        })),
        { text: CANCEL.label, style: 'cancel' as const },
      ],
      { cancelable: true },
    );
  }, [kind, text, extras, pick]);

  return (
    <>
      <Pressable
        accessibilityHint="Long-press for Copy and Select text"
        onLongPress={disabled ? undefined : show}
        delayLongPress={450}
        // No `onPress`: the children keep their taps.
        style={styles.fill}
      >
        {children}
      </Pressable>
      {sheet.element}
    </>
  );
}

// The row's full width: a bubble inside keeps its 80 % and its right side.
const styles = { fill: { minWidth: 0, alignSelf: 'stretch' } } as const;
