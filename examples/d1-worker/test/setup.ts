import { env, reset } from "cloudflare:test";
import { beforeEach, expect } from "vitest";

beforeEach(async () => {
  await reset();
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all();
  expect(tables.results).toEqual([]);
  for (const statement of JSON.parse(env.TEST_SCHEMA_QUERIES) as string[]) await env.DB.prepare(statement).run();
});

export async function seedUsers(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, name, nickname) VALUES (?, ?, ?)").bind(1, "Ada", "ada"),
    env.DB.prepare("INSERT INTO users (id, name, nickname) VALUES (?, ?, ?)").bind(2, "Grace", null),
  ]);
}
