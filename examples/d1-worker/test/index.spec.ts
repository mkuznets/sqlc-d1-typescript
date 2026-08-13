import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedUsers } from "./setup";

describe("canonical users Worker", () => {
	it("example/list-users returns users in ID order", async () => {
		await seedUsers();
		const response = await SELF.fetch("https://example.com/users");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ users: [
			{ id: 1, name: "Ada", nickname: "ada" },
			{ id: 2, name: "Grace", nickname: null },
		] });
	});

	it("example/get-user batches the selected user and list", async () => {
		await seedUsers();
		const found = await SELF.fetch("https://example.com/users/1");
		expect(found.status).toBe(200);
		expect(await found.json()).toEqual({ user: { id: 1, name: "Ada", nickname: "ada" }, users: [
			{ id: 1, name: "Ada", nickname: "ada" }, { id: 2, name: "Grace", nickname: null },
		] });
		const missing = await SELF.fetch("https://example.com/users/99");
		expect(missing.status).toBe(200);
		expect(await missing.json()).toEqual({ user: null, users: [
			{ id: 1, name: "Ada", nickname: "ada" }, { id: 2, name: "Grace", nickname: null },
		] });
	});

	it("example/rename-user uses a request-local session and rejects invalid input", async () => {
		await seedUsers();
		const response = await SELF.fetch("https://example.com/users/1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Augusta" }) });
		expect(response.status).toBe(200);
		const body = await response.json() as { user: unknown; bookmarkAvailable: boolean };
		expect(body.user).toEqual({ id: 1, name: "Augusta", nickname: "ada" });
		expect(typeof body.bookmarkAvailable).toBe("boolean");
		const invalid = await SELF.fetch("https://example.com/users/1", { method: "PATCH", body: JSON.stringify({ name: "x", extra: true }) });
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "invalid_request" });
	});

	it("example/routing-statuses distinguishes known paths, methods, and malformed inputs", async () => {
		const listMethod = await SELF.fetch("https://example.com/users", { method: "POST" });
		expect(listMethod.status).toBe(405);
		expect(await listMethod.json()).toEqual({ error: "method_not_allowed" });
		const userMethod = await SELF.fetch("https://example.com/users/not-an-id", { method: "DELETE" });
		expect(userMethod.status).toBe(405);
		expect(await userMethod.json()).toEqual({ error: "method_not_allowed" });
		const malformedId = await SELF.fetch("https://example.com/users/not-an-id");
		expect(malformedId.status).toBe(400);
		expect(await malformedId.json()).toEqual({ error: "invalid_request" });
		const absentRoute = await SELF.fetch("https://example.com/absent");
		expect(absentRoute.status).toBe(404);
		expect(await absentRoute.json()).toEqual({ error: "not_found" });
	});

	it("example/error-boundary does not label native failures as generated errors", async () => {
		await env.DB.prepare("DROP TABLE users").run();
		const response = await SELF.fetch("https://example.com/users");
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "internal_error" });
	});
});
