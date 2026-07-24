import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging } from "./lib/log";
import { applyCachedThemeSync } from "./lib/theme";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "./index.css";

installGlobalErrorLogging();
applyCachedThemeSync();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
