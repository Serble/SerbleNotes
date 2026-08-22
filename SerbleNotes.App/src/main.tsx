import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { watchKeyboard } from './services/viewport';
import './index.css';

watchKeyboard();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
