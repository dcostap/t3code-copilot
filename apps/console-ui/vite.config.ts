import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 5734);

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["@pierre/diffs"],
  },
  server: {
    port,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
