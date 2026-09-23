import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { Waitlist } from './Waitlist';

const waitlist = /^\/waitlist(?:\/pitch)?\/?$/.test(window.location.pathname);
createRoot(document.getElementById('root')!).render(<React.StrictMode>{waitlist ? <Waitlist pitch={/^\/waitlist\/pitch\/?$/.test(window.location.pathname)}/> : <App />}</React.StrictMode>);
