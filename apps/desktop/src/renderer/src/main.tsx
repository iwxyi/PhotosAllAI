import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Application render failed', error, info.componentStack); }

  render(): ReactNode {
    if (this.state.error) return <main className="app-startup-error" role="alert"><h1>界面加载失败</h1><p>{this.state.error.message}</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>
);

