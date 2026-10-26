import { afterEach, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import type { SkillInfo } from '../../gen/contract';
import { Composer } from './Composer';

const SKILLS: SkillInfo[] = [
  {
    id: 'changelog',
    title: 'changelog',
    description: 'Write the changelog entry',
    source: '~/.claude/skills',
  },
  {
    id: 'docs',
    title: 'docs',
    description: 'Update the docs',
    source: 'acme/web · .claude/skills',
  },
];

let m: Mounted | null = null;
let sent: string[] = [];

afterEach(() => {
  m?.unmount();
  m = null;
  sent = [];
});

function Box() {
  const [text, setText] = useState('');
  return (
    <Composer
      value={text}
      onChange={setText}
      onSubmit={() => {
        sent.push(text);
        setText('');
      }}
      placeholder="Ask the agent"
      skills={SKILLS}
    />
  );
}

const box = () => m!.host.querySelector('textarea')!;
const key = (k: string) =>
  act(async () => {
    box().dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  });

describe('Composer skills', () => {
  it('lists the skills after / and filters them as you type', async () => {
    m = await mount(<Box />);
    await typeInto(box(), '/');
    await settle();
    expect(m.host.querySelector('.slash-menu')?.textContent).toContain(
      '/changelog',
    );
    await typeInto(box(), '/do');
    await settle();
    const menu = m.host.querySelector('.slash-menu')!;
    expect(menu.textContent).toContain('/docs');
    expect(menu.textContent).not.toContain('/changelog');
  });

  it('⏎ puts the skill in the box instead of sending', async () => {
    m = await mount(<Box />);
    await typeInto(box(), '/doc');
    await settle();
    await key('Enter');
    await settle();
    expect(sent).toEqual([]);
    expect(box().value).toBe('/docs ');
    // A space ends the name: the list closes and ⏎ sends.
    expect(m.host.querySelector('.slash-menu')).toBeNull();
    await typeInto(box(), '/docs for the new flag');
    await key('Enter');
    await settle();
    expect(sent).toEqual(['/docs for the new flag']);
  });

  it('Esc closes the list and clears the /', async () => {
    m = await mount(<Box />);
    await typeInto(box(), '/');
    await settle();
    await key('Escape');
    await settle();
    expect(box().value).toBe('');
    expect(m.host.querySelector('.slash-menu')).toBeNull();
  });

  it('the / button opens the list', async () => {
    m = await mount(<Box />);
    await click(m.host.querySelector('button[aria-label="Skills"]'));
    await settle();
    expect(box().value).toBe('/');
    expect(m.host.querySelector('.slash-menu')).not.toBeNull();
  });
});
