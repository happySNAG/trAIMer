import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  publicDir: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../dist-app",
    emptyOutDir: true,
    target: "es2022",
  },
});
