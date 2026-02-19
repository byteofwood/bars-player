import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  const useHttps = mode === "https";
  const useGithubPagesBase = mode === "pages";
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const pagesBase = env?.VITE_BASE_PATH || "/bars-player/";

  return {
    base: useGithubPagesBase ? pagesBase : "/",
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    server: {
      https: useHttps,
    },
    preview: {
      https: useHttps,
    },
  };
});
