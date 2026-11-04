import { Component, type ReactNode } from 'react';

/** Keeps a rendering error in one part of a view (a card on the map, a block's editor) from taking the whole app down:
 * the part shows `fallback` instead, and draws again once `retry` changes (its content did). */
export class PartBoundary extends Component<{ children: ReactNode; fallback: (message: string) => ReactNode; retry?: string }, { message: string | null; retry?: string }> {
  state = { message: null as string | null, retry: this.props.retry };
  static getDerivedStateFromError(error: unknown) { return { message: error instanceof Error ? error.message : String(error) }; }
  static getDerivedStateFromProps(props: { retry?: string }, state: { retry?: string }) { return props.retry === state.retry ? null : { message: null, retry: props.retry }; }
  componentDidCatch(error: unknown) { console.error('ros.ai: part of the view could not be shown.', error); }
  render() { return this.state.message === null ? this.props.children : this.props.fallback(this.state.message); }
}

/** Keeps a rendering error from blanking the page. Saved work lives on the server, so reloading is safe. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { message: error instanceof Error ? error.message : String(error) }; }
  render() {
    if (this.state.message === null) return this.props.children;
    return <main className="app-crash" role="alert">
      <h1>Something went wrong in this view</h1>
      <p>Your projects are saved on this computer. Reload to continue.</p>
      <pre>{this.state.message}</pre>
      <button type="button" onClick={() => window.location.reload()}>Reload</button>
    </main>;
  }
}
