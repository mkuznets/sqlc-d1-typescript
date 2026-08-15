import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery } from "wrangler";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const schemaQueries = unstable_splitSqlQuery(readFileSync(schemaPath, "utf8"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: { bindings: { TEST_SCHEMA_QUERIES: JSON.stringify(schemaQueries) } },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
