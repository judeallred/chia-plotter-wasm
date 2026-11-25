import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// SharedArrayBuffer (needed for WASM threads) requires cross-origin isolation.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// The URL path the site is served under. "/" by default; the xch.nyc deploy builds with
// PLOTTER_BASE=/plotter/. It always ends with a slash, so code can append to BASE_URL.
const base = `/${(process.env.PLOTTER_BASE ?? "").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

export default defineConfig({
  base,
  server: { headers: isolation },
  vite: {
    plugins: [tailwindcss()],
    server: { headers: isolation },
    preview: { headers: isolation },
    worker: { format: "es" },
  },
});
