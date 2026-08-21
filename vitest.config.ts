import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["dist/**", "node_modules/**", "eval/e1/**"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
