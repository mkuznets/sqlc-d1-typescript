import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedUsers } from "./setup";

const ada = { id: 1, name: "Ada", nickname: "ada" };
const grace = { id: 2, name: "Grace", nickname: null };

describe("canonical users Worker", () => {
  it("lists users in ID order", async () => {
    await seedUsers();

    const response = await SELF.fetch("https://example.com/users");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ users: [ada, grace] });
  });

  it("batches the selected user and the list", async () => {
    await seedUsers();

    const found = await SELF.fetch("https://example.com/users/1");
    expect(await found.json()).toEqual({ user: ada, users: [ada, grace] });

    const missing = await SELF.fetch("https://example.com/users/99");
    expect(await missing.json()).toEqual({ user: null, users: [ada, grace] });
  });

  it("renames a user through a request-local session", async () => {
    await seedUsers();

    const response = await SELF.fetch("https://example.com/users/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Augusta" }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { user: unknown; bookmarkAvailable: boolean };
    expect(body.user).toEqual({ ...ada, name: "Augusta" });
    expect(typeof body.bookmarkAvailable).toBe("boolean");
  });

  it("rejects a malformed argument before it reaches D1", async () => {
    await seedUsers();

    const badId = await SELF.fetch("https://example.com/users/not-an-id");
    expect(badId.status).toBe(500);
    expect(await badId.json()).toEqual({ error: "query_failed" });

    const badName = await SELF.fetch("https://example.com/users/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "augusta" }),
    });
    expect(badName.status).toBe(500);
    expect(await badName.json()).toEqual({ error: "query_failed" });
  });

  it("does not label native failures as generated errors", async () => {
    await env.DB.prepare("DROP TABLE users").run();

    const response = await SELF.fetch("https://example.com/users");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
