import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  publicDir: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Local-first app on a fixed Chromium matrix: no fetch()-based
    // module-preload polyfill in shipped code (no-telemetry audit).
    modulePreload: false,
    outDir: "../dist-app",
    emptyOutDir: true,
    target: "es2022",
  },
});
