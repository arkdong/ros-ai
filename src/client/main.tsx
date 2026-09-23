import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';

if (/^\/waitlist(?:\/pitch)?\/?$/.test(window.location.pathname)) {
  window.location.replace('/app');
} else {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}
