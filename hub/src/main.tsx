import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { SessionProvider } from "@/lib/session";

/**
 * HashRouter, not BrowserRouter.
 *
 * This bundle is published to /hub/ on the same GitHub Pages site as the static
 * app. Pages has no SPA rewrite, so a student who bookmarks /hub/schedule, or
 * refreshes on it, gets Pages' 404 rather than the app. A hash route is served
 * by /hub/index.html every time. It costs an ugly URL and it removes an entire
 * class of "it worked until I reloaded".
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </HashRouter>
  </StrictMode>,
);
