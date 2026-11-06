import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20000,
    fileParallelism: false,
  },
});
