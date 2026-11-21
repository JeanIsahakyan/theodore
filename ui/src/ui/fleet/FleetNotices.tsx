/** What the fleet puts in front of you wherever you are (docs/fleet.md):
 *  questions of agents on other devices, routed to this one, as cards that
 *  block nothing; and the decisions waiting on you — requests from Claude
 *  via the cloud, devices asking to run spaces here — as a dialog
 *  (`FleetPrompts`). Auto modes on show in the tab bar (`FleetChrome`). */
import { observer } from 'mobx-react-lite';
import { useRootStore, useUi } from '../../stores/context';
import { FleetPrompts } from './FleetPrompts';
import { FleetQuestionCard } from './FleetQuestionCard';

export const FleetNotices = observer(function FleetNotices() {
  const store = useRootStore();
  const ui = useUi();
  const fleet = store.fleet;
  if (!fleet.available) return null;
  const route = ui.route;
  // The space's own page already shows its question (a remote space's id
  // is its fleet id).
  const asks = fleet.askList.filter(
    (q) => !(route.name === 'space' && route.id === q.space),
  );
  return (
    <>
      {asks.length > 0 && (
        <div className="fleet-notices pointer-events-none absolute right-4 top-12 z-30 flex max-h-[75vh] w-[420px] max-w-[calc(100%-2rem)] flex-col gap-2 overflow-auto [&>*]:pointer-events-auto">
          {asks.map((q) => (
            <FleetQuestionCard
              key={q.ask_id}
              question={q}
              className="bg-surface shadow-lg"
            />
          ))}
        </div>
      )}
      <FleetPrompts />
    </>
  );
});
