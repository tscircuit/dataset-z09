import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createNearestNeighborVitePlugin } from "./lib/vite-nearest-neighbor-plugin";

export default defineConfig({
  plugins: [react(), createNearestNeighborVitePlugin()],
  resolve: {
    alias: {
      lib: fileURLToPath(new URL("./lib", import.meta.url)),
      tests: fileURLToPath(new URL("./tests", import.meta.url)),
    },
  },
});
