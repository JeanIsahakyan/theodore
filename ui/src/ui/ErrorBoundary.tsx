/** The top-level error boundary: a render crash anywhere below shows a
 *  friendly full-window screen instead of a blank one, and goes to the
 *  core's log once.
 *
 *  Sits outside the store provider and uses only plain elements, so it
 *  still renders when the store or a provider is what crashed. */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportBoundaryError } from '../core/clientLog';
import { ReportProblemView } from './ReportProblem';

type Props = { children: ReactNode };
type State = { crashed: boolean; reporting: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false, reporting: false };

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportBoundaryError(error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="error-screen flex h-full items-center-safe justify-center-safe overflow-auto bg-background p-6 text-foreground">
        <div className="flex w-full max-w-[480px] flex-col gap-4">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted">
            Theodore hit an unexpected error. Reloading usually fixes it.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="error-reload button button--primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            {!this.state.reporting && (
              <button
                type="button"
                className="error-report button button--secondary"
                onClick={() => this.setState({ reporting: true })}
              >
                Report a problem
              </button>
            )}
          </div>
          {this.state.reporting && <ReportProblemView />}
        </div>
      </div>
    );
  }
}
