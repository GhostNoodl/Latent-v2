import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** What failed, in the user's words ("Models", "the studio"). */
  label: string;
  /** Changing this value (for example the open page) clears a previous failure. */
  resetKey?: unknown;
  children: ReactNode;
}
interface State {
  error?: Error;
  resetKey?: unknown;
}

/**
 * Contains a rendering failure to one view, so one broken panel cannot blank the whole studio
 * while generation keeps running in the background.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { resetKey: props.resetKey, error: undefined } : null;
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} stopped rendering`, error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="view-error" role="alert">
        <h2>{this.props.label} hit a problem</h2>
        <p>Your queue and saved work are safe. This view stopped because of an unexpected error.</p>
        <pre>{error.message}</pre>
        <div className="view-error-actions">
          <button type="button" onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload studio
          </button>
        </div>
      </div>
    );
  }
}
