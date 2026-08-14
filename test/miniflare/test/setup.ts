import { env } from 'cloudflare:test';
import { beforeEach, expect } from 'vitest';

beforeEach(async () => {
	const before = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
	).all<{ name: string }>();
	expect(before.results, 'isolated D1 storage must start without application tables').toEqual([]);

	const statements = JSON.parse(env.TEST_SCHEMA_QUERIES) as string[];
	for (const statement of statements) await env.DB.prepare(statement).run();

	const after = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
	).all<{ name: string }>();
	expect(after.results.map(({ name }) => name)).toEqual(['feeds', 'files', 'item_notes', 'items', 'quirks', 'samples']);
});
