/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` proxies the API to the jackett-ui Go server (server/), which does the login and
// talks to Jackett itself. Run it next to Vite and point UI_SERVER_URL at it:
//   cd server && JACKETT_URL=http://127.0.0.1:9117 LISTEN=127.0.0.1:8080 go run .
//   UI_SERVER_URL=http://127.0.0.1:8080 npm run dev
// changeOrigin stays off: the server's CSRF check compares Origin with the Host it sees,
// and the OIDC redirect URL is derived from the Host too (localhost:5173).
const uiServer = process.env.UI_SERVER_URL ?? "http://127.0.0.1:8080";
const proxied = ["/api", "/dl", "/bh", "/UI", "/_ui", "/healthz"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("@radix-ui") || id.includes("lucide-react")) return "ui";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: uiServer, changeOrigin: false }])),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    exclude: ["node_modules", "dist"],
  },
});
