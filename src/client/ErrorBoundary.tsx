import { Component, type ReactNode } from 'react';

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
