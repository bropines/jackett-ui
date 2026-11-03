/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` proxies Jackett. Point JACKETT_URL at any Jackett instance, e.g. an SSH tunnel:
//   ssh -L 9117:127.0.0.1:9117 your-server   →   JACKETT_URL=http://127.0.0.1:9117 npm run dev
const jackett = process.env.JACKETT_URL ?? "http://127.0.0.1:9117";
const proxied = ["/api", "/dl", "/bh", "/UI"];

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
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: jackett, changeOrigin: true }])),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    exclude: ["node_modules", "dist"],
  },
});
