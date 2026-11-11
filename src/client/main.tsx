import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './refined.css';
import './mac-app.css';

// The Mac app window has no system title bar; App draws its own strip instead (desktop/src/main.ts adds ros.ai/<version>).
if (/Macintosh/.test(navigator.userAgent) && / ros\.ai\/\S+$/.test(navigator.userAgent)) document.documentElement.classList.add('mac-app');

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
