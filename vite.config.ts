import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  const useHttps = mode === "https";

  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    server: {
      https: useHttps,
    },
    preview: {
      https: useHttps,
    },
  };
});
