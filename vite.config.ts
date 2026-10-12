import { defineConfig } from "vite";
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/media": "http://127.0.0.1:4318",
    },
  },
  build: { target: "es2022" },
});
