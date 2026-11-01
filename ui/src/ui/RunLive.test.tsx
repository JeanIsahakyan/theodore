/** Live run output: a run's streamed text re-renders only its own view. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { LiveText } from './RunLive';

let transport: FakeTransport;
let store: RootStore;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  store = new RootStore();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const delta = (run: string, text: string) =>
  act(() =>
    store.ephemeral.handle({ type: 'agent_delta', run, agent: 'claude', text }),
  );
async function render(node: React.ReactNode) {
  await act(async () =>
    root.render(<RootStoreProvider store={store}>{node}</RootStoreProvider>),
  );
}

describe('LiveText', () => {
  it('shows the fallback, then the text as it streams, without re-rendering the view around it', async () => {
    let outer = 0;
    const Chat = observer(function Chat() {
      outer += 1;
      return <LiveText run="r1" fallback={<i className="dots" />} />;
    });
    await render(<Chat />);
    expect(host.querySelector('.dots')).not.toBeNull();

    delta('r1', 'Hel');
    delta('r1', 'lo');
    delta('r2', 'other run');
    expect(host.querySelector('.live-text')?.textContent).toBe('Hello');
    expect(outer).toBe(1);
  });
});
