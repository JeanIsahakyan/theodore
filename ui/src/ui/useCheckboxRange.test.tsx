import { act, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkbox } from '@heroui/react';
import { mount, type Mounted } from '../test/dom';
import {
  useCheckboxRange,
  useCheckboxRangeEvents,
  type CheckboxRangeModifiers,
} from './useCheckboxRange';

function RangeCheckbox({
  id,
  checked,
  onPick,
}: {
  id: string;
  checked: boolean;
  onPick: (checked: boolean, modifiers: CheckboxRangeModifiers) => void;
}) {
  const events = useCheckboxRangeEvents(onPick);
  return (
    <span
      className="contents"
      data-range-key={id}
      onClickCapture={events.onClickCapture}
      onBlurCapture={events.onBlurCapture}
      onKeyDownCapture={events.onKeyDownCapture}
    >
      <Checkbox isSelected={checked} onChange={events.onCheckboxChange}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span>{id}</span>
        </Checkbox.Content>
      </Checkbox>
    </span>
  );
}

function Harness({ scopeKey, order }: { scopeKey: string; order: string[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const range = useCheckboxRange({
    scopeKey,
    orderedKeys: order,
    onChange: (keys, checked) =>
      setPicked((current) => {
        const changed = new Set(keys);
        return checked
          ? [...new Set([...current, ...keys])]
          : current.filter((id) => !changed.has(id));
      }),
  });
  return (
    <div>
      {order.map((id) => (
        <RangeCheckbox
          key={id}
          id={id}
          checked={picked.includes(id)}
          onPick={(checked, modifiers) =>
            range.activate(id, checked, modifiers)
          }
        />
      ))}
    </div>
  );
}

let view: Mounted | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

async function render(scopeKey = 'one', order = ['a', 'b', 'c', 'd']) {
  view = await mount(<Harness scopeKey={scopeKey} order={order} />);
}

async function rerender(scopeKey: string, order: string[]) {
  await act(async () =>
    view!.root.render(<Harness scopeKey={scopeKey} order={order} />),
  );
}

async function clickCheckbox(id: string, shiftKey = false, detail = 1) {
  const input = view!.host.querySelector<HTMLInputElement>(
    `[data-range-key="${id}"] input[type="checkbox"]`,
  );
  if (!input) throw new Error(`No checkbox input for ${id}`);
  await act(async () => {
    input.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail,
        shiftKey,
      }),
    );
  });
}

function checked() {
  return [
    ...view!.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ]
    .filter((input) => input.checked)
    .map((input) =>
      input.closest('[data-range-key]')?.getAttribute('data-range-key'),
    );
}

describe('useCheckboxRange with HeroUI checkboxes', () => {
  it('selects forward, clears reverse, and preserves picks outside the range', async () => {
    await render();
    await clickCheckbox('b');
    await clickCheckbox('d', true);
    expect(checked()).toEqual(['b', 'c', 'd']);

    await clickCheckbox('c', true);
    expect(checked()).toEqual(['d']);
  });

  it('uses the current order and invalidates an anchor hidden by filtering', async () => {
    await render();
    await clickCheckbox('b');
    await rerender('one', ['d', 'c', 'b', 'a']);
    await clickCheckbox('d', true);
    expect(checked()).toEqual(['d', 'c', 'b']);

    await rerender('one', ['a', 'b', 'c', 'd']);
    await clickCheckbox('a');
    await rerender('one', ['b', 'c', 'd']);
    await clickCheckbox('d', true);
    await rerender('one', ['a', 'b', 'c', 'd']);
    await clickCheckbox('b', true);
    expect(checked()).toEqual(['a']);
  });

  it('resets its anchor when the collection scope changes', async () => {
    await render();
    await clickCheckbox('a');
    await rerender('two', ['a', 'b', 'c', 'd']);
    await clickCheckbox('d', true);
    expect(checked()).toEqual(['a', 'd']);
  });

  it('keeps an ordinary click after Shift and Space activation single-item', async () => {
    await render();
    await clickCheckbox('b');
    await clickCheckbox('d', true);
    await clickCheckbox('a');
    await clickCheckbox('b', true);
    expect(checked()).toEqual(['c', 'd']);

    const input = view!.host.querySelector<HTMLInputElement>(
      '[data-range-key="a"] input[type="checkbox"]',
    )!;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          key: ' ',
          code: 'Space',
        }),
      );
      input.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, key: ' ', code: 'Space' }),
      );
    });
    expect(checked()).toEqual(['a', 'c', 'd']);
  });
});
