import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
