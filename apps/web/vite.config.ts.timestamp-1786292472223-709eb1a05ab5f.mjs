// vite.config.ts
import react from "file:///Users/bartoszwolak/PULPIT/XD/Harness-Engineering/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@6.4.3_@types+node@26.1.2_jiti@1.21.7_tsx@4.23.10_yaml@2.9.0_/node_modules/@vitejs/plugin-react/dist/index.js";
import { defineConfig } from "file:///Users/bartoszwolak/PULPIT/XD/Harness-Engineering/node_modules/.pnpm/vite@6.4.3_@types+node@26.1.2_jiti@1.21.7_tsx@4.23.10_yaml@2.9.0/node_modules/vite/dist/node/index.js";
var vite_config_default = defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // HTTP API — forward /workflows to the Fastify server
      "/workflows": {
        target: "http://localhost:3000",
        changeOrigin: true
      },
      // WebSocket stream — forward /stream to the Fastify server
      "/stream": {
        target: "ws://localhost:3000",
        ws: true
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvYmFydG9zendvbGFrL1BVTFBJVC9YRC9IYXJuZXNzLUVuZ2luZWVyaW5nL2FwcHMvd2ViXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvYmFydG9zendvbGFrL1BVTFBJVC9YRC9IYXJuZXNzLUVuZ2luZWVyaW5nL2FwcHMvd2ViL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9iYXJ0b3N6d29sYWsvUFVMUElUL1hEL0hhcm5lc3MtRW5naW5lZXJpbmcvYXBwcy93ZWIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgcmVhY3QgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXJlYWN0XCI7XG5pbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbcmVhY3QoKV0sXG4gIHNlcnZlcjoge1xuICAgIHByb3h5OiB7XG4gICAgICAvLyBIVFRQIEFQSSBcdTIwMTQgZm9yd2FyZCAvd29ya2Zsb3dzIHRvIHRoZSBGYXN0aWZ5IHNlcnZlclxuICAgICAgXCIvd29ya2Zsb3dzXCI6IHtcbiAgICAgICAgdGFyZ2V0OiBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMFwiLFxuICAgICAgICBjaGFuZ2VPcmlnaW46IHRydWUsXG4gICAgICB9LFxuICAgICAgLy8gV2ViU29ja2V0IHN0cmVhbSBcdTIwMTQgZm9yd2FyZCAvc3RyZWFtIHRvIHRoZSBGYXN0aWZ5IHNlcnZlclxuICAgICAgXCIvc3RyZWFtXCI6IHtcbiAgICAgICAgdGFyZ2V0OiBcIndzOi8vbG9jYWxob3N0OjMwMDBcIixcbiAgICAgICAgd3M6IHRydWUsXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBZ1csT0FBTyxXQUFXO0FBQ2xYLFNBQVMsb0JBQW9CO0FBRTdCLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixRQUFRO0FBQUEsSUFDTixPQUFPO0FBQUE7QUFBQSxNQUVMLGNBQWM7QUFBQSxRQUNaLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxNQUNoQjtBQUFBO0FBQUEsTUFFQSxXQUFXO0FBQUEsUUFDVCxRQUFRO0FBQUEsUUFDUixJQUFJO0FBQUEsTUFDTjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
