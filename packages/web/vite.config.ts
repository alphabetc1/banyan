import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the room server runs separately; proxy the API and WebSocket to it.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: process.env.BANYAN_SERVER ?? "http://127.0.0.1:7700", ws: true },
    },
  },
});
