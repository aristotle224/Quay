import { defineConfig } from "vitest/config";

// Scoped to scripts/ only - each workspace package (apps/*, packages/*) runs
// its own vitest instance via its own "test" script through turbo; this root
// config exists solely for scripts/, which isn't a workspace package.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
