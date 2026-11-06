import { defineConfig } from "vite";

// Relative base so the build works on any host or subpath
// (e.g. https://<user>.github.io/running-form-analyzer/).
export default defineConfig({
  base: "./",
  // MediaPipe's wasm loader is served as a static asset (see src/pose.ts),
  // so keep Vite's dep optimizer away from the package.
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
