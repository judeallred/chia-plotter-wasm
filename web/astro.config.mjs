import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// SharedArrayBuffer (needed for WASM threads) requires cross-origin isolation.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { headers: isolation },
  vite: {
    plugins: [tailwindcss()],
    server: { headers: isolation },
    preview: { headers: isolation },
    worker: { format: "es" },
  },
});
