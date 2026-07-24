import React from 'react';
import ReactDOM from 'react-dom/client';
import { HistoryWindow } from './windows/HistoryWindow';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <HistoryWindow />
  </React.StrictMode>
);