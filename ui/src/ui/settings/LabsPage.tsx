/** Settings → Labs: one switch per feature in progress (`labs.ts`). */
import { Card, Switch } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { setSetting } from '../../actions';
import { useRootStore } from '../../stores/context';
import { LABS, labOn } from './labs';

export const LabsPage = observer(function LabsPage() {
  const store = useRootStore();
  const settings = store.models.settings.all();
  return (
    <Card variant="secondary" className="labs gap-0 p-0">
      {LABS.map((lab) => (
        <div
          key={lab.key}
          className="set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{lab.title}</span>
            <span className="text-xs text-muted">{lab.text}</span>
          </div>
          <Switch
            size="sm"
            aria-label={lab.title}
            isSelected={labOn(settings, lab.key)}
            onChange={(v) => setSetting(store, 'user', lab.key, v)}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </div>
      ))}
    </Card>
  );
});
