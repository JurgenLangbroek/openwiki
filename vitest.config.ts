import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before every test file's own module graph, which is what makes the
    // OpenWiki home safe by default instead of by convention. See
    // test/support/openwiki-home-guard.ts.
    setupFiles: ["./test/support/openwiki-home-guard.ts"],
  },
});
