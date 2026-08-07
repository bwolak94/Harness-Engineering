import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // HTTP API — forward /workflows to the Fastify server
      "/workflows": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      // WebSocket stream — forward /stream to the Fastify server
      "/stream": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
