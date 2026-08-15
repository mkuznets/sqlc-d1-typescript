declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_SCHEMA_QUERIES: string;
  }
}
