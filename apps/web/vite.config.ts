import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // HTTP API — forward all known API prefixes to the Fastify server
      "/workflows": { target: "http://localhost:3001", changeOrigin: true },
      "/sandbox": { target: "http://localhost:3001", changeOrigin: true },
      "/mcp": { target: "http://localhost:3001", changeOrigin: true },
      "/tenants": { target: "http://localhost:3001", changeOrigin: true },
      "/health": { target: "http://localhost:3001", changeOrigin: true },
      // WebSocket stream — forward /stream to the Fastify server
      "/stream": { target: "ws://localhost:3001", ws: true },
    },
  },
});
