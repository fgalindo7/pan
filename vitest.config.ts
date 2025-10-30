import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, "src"),
    },
  },
});
