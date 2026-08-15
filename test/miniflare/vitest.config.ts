import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { unstable_splitSqlQuery } from "wrangler";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const schemaQueries = unstable_splitSqlQuery(readFileSync(schemaPath, "utf8"));

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: { bindings: { TEST_SCHEMA_QUERIES: JSON.stringify(schemaQueries) } },
      },
    },
  },
});
