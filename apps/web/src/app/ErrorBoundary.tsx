import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * ErrorBoundary — prevents an unhandled render error from showing a blank page.
 * Shows a minimal error card with the message and a reload button.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[harness] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-canvas">
          <div className="max-w-md space-y-3 rounded border border-ev-error/30 bg-surface p-6">
            <p className="text-sm font-medium text-ev-error">Render error</p>
            <p className="font-mono text-xs text-[#a1a1aa]">{this.state.error.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="rounded bg-surface-2 px-3 py-1.5 text-xs text-[#a1a1aa] hover:text-white transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
