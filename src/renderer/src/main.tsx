import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createHashHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./lib/i18n";
import "./styles/globals.css";

const queryClient = new QueryClient({
  // refetchOnWindowFocus defaults to true in react-query - meant for a browser tab that's been
  // sitting stale while the user was elsewhere, but Electron's webContents can fire that same
  // focus event from far more mundane interactions than actually switching away and back (a
  // scroll, a click that briefly shifts focus between elements, ...). Every one of those was
  // silently refetching queries like recent-progress mid-interaction - components that derive
  // local state from query data (a scroll position, an in-flight index) don't expect their data
  // to be swapped out from under them like that, and it read as things randomly resetting for no
  // reason. Nothing here benefits from "revalidate on focus" the way a live web dashboard would.
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
});

// Middle-clicking any link (the hero's "Open" button, anime cards, ...) is Chromium's native
// "open in a new tab" gesture - main/index.ts forwards new-window requests to the real OS browser
// via shell.openExternal, so a stray middle-click (e.g. while starting a middle-click-drag
// autoscroll over the hero banner) launches an external browser on an internal app route instead
// of doing nothing. Suppress that default action app-wide; left-click navigation is unaffected.
window.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); }, { capture: true });

// Hash history, not the router's default browser (pushState) history - a packaged build loads the
// renderer via `mainWindow.loadFile(...)` (a real `file://` URL), not an http server like dev mode
// does, and pushState-based routes there resolve against that literal file path rather than a
// normal origin+pathname. Once onboarding completes and __root.tsx actually renders <Outlet/> for
// the first time, the router tries to match `location.pathname` - `/C:/.../dist/index.html` - against
// the route tree, matches nothing, and falls back to its default "Not Found" screen; every route
// after that first navigation staying broken the same way. Hash history keeps the whole route
// (`#/settings`, ...) after the `#`, which `file://` never touches, so it works identically in dev
// (over http) and in a packaged build (over file://) - there's no visible address bar in this app
// for the `#` to look out of place in anyway.
const router = createRouter({ routeTree, scrollRestoration: true, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
