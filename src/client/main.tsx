import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './refined.css';
import './mac-app.css';

// The Mac app window has no system title bar; it gets our own strip instead (desktop/src/main.ts adds ros.ai/<version>).
if (/Macintosh/.test(navigator.userAgent) && / ros\.ai\/\S+$/.test(navigator.userAgent)) {
  document.documentElement.classList.add('mac-app');
  document.body.prepend(Object.assign(document.createElement('div'), { className: 'mac-titlebar' }));
}

if (/^\/waitlist(?:\/pitch)?\/?$/.test(window.location.pathname)) {
  window.location.replace('/app');
} else {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
}
