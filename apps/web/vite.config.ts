import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, currentDirectory, "");
  const apiTarget = env.VITE_MABEL_API_URL || "http://127.0.0.1:8820";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(currentDirectory, "src"),
      },
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },
    server: {
      host: "127.0.0.1",
      port: Number(env.VITE_PORT || 5173),
      proxy: {
        "/mabel-api": {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
          timeout: 0,
          proxyTimeout: 0,
          rewrite: (requestPath) => requestPath.replace(/^\/mabel-api/, ""),
        },
      },
    },
  };
});
