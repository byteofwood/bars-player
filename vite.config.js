var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
export default defineConfig(function (_a) {
    var _b;
    var mode = _a.mode;
    var useHttps = mode === "https";
    var useGithubPagesBase = mode === "pages";
    var env = (_b = globalThis.process) === null || _b === void 0 ? void 0 : _b.env;
    var pagesBase = (env === null || env === void 0 ? void 0 : env.VITE_BASE_PATH) || "/bars-player/";
    return {
        base: useGithubPagesBase ? pagesBase : "/",
        plugins: __spreadArray([react()], (useHttps ? [basicSsl()] : []), true),
        server: {
            https: useHttps,
        },
        preview: {
            https: useHttps,
        },
    };
});
