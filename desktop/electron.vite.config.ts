import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs"
        }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [
      react(),
      ...(command === "serve"
        ? [
            {
              name: "magi-development-style-csp",
              transformIndexHtml(html: string): string {
                return html.replace(
                  "style-src 'self'",
                  "style-src 'self' 'unsafe-inline'"
                );
              }
            }
          ]
        : [])
    ],
    server: {
      // Keep Magi isolated from other local Vite apps. Without a strict,
      // dedicated port, Electron can load another app's renderer assets when
      // that app is already listening on Vite's default 5173 port.
      port: 5187,
      strictPort: true
    }
  }
}));
