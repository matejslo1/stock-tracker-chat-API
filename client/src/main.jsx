// 🔐 Inject API key into all /api/* calls
const originalFetch = window.fetch;

window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url && url.includes("/api/")) {
    const headers = new Headers(init.headers || {});
    const key = import.meta.env.VITE_API_KEY;

    if (key) {
      headers.set("x-api-key", key);
    }

    init = { ...init, headers };
  }

  return originalFetch(input, init);
};
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
