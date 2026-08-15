import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery } from "wrangler";

const migration = fileURLToPath(new URL("./migrations/0001_init.sql", import.meta.url));
const statements = unstable_splitSqlQuery(readFileSync(migration, "utf8"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: { bindings: { TEST_SCHEMA_QUERIES: JSON.stringify(statements) } },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
