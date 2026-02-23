import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

/**
 * 🔐 Global API key injection
 * Automatically attaches x-api-key header
 * to all requests going to /api/*
 */
const originalFetch = window.fetch;

window.fetch = async (input, init = {}) => {
  try {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
        ? input.url
        : "";

    // Attach only to backend API calls
    if (url.includes("/api/")) {
      const headers = new Headers(init.headers || {});
      const apiKey = import.meta.env.VITE_API_KEY;

      if (apiKey) {
        headers.set("x-api-key", apiKey);
      } else {
        console.warn("⚠️ VITE_API_KEY is not defined");
      }

      init = { ...init, headers };
    }

    return originalFetch(input, init);
  } catch (err) {
    console.error("Fetch wrapper error:", err);
    return originalFetch(input, init);
  }
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);