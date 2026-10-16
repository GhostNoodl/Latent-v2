import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';
import './usability.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="The studio">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
