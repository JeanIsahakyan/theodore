import { describe, expect, it } from 'vitest';
import { UiStore } from './UiStore';

describe('UiStore tabs', () => {
  it('opens every new tab at the end', () => {
    localStorage.clear();
    const ui = new UiStore();
    ui.go({ name: 'review', pr: 'github:o/r#1' });
    ui.go({ name: 'review', pr: 'github:o/r#2' });
    ui.go({ name: 'inbox' }); // existing tab: just switches
    ui.go({ name: 'review', pr: 'github:o/r#3' });
    ui.newTab();
    expect(ui.tabs.map((t) => (t.name === 'review' ? t.pr : t.name))).toEqual([
      'inbox',
      'github:o/r#1',
      'github:o/r#2',
      'github:o/r#3',
      'new',
    ]);
  });
});
