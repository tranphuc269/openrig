import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const daemonUrl = process.env.OPENRIG_URL ?? process.env.RIGGED_URL ?? "http://localhost:7433";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: daemonUrl,
        changeOrigin: true,
        // Dev only: the daemon accepts browser writes only from its own UI origin, so present the
        // proxied request as coming from the daemon's address instead of the Vite port.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", new URL(daemonUrl).origin);
          });
        },
      },
      "/healthz": {
        target: daemonUrl,
        changeOrigin: true,
      },
    },
  },
});
