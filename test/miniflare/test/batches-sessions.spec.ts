import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DB, QueryResultError, QueryUsageError, SqlcD1Error, type QueryDescriptor } from '../src/runtime';
import { createQuirk } from '../src/queries_sql';

async function caught(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

function descriptor<Result>(value: Record<string, unknown>): QueryDescriptor<Result> {
	return Object.freeze(value) as unknown as QueryDescriptor<Result>;
}

const exec = (name: string, sql: string): QueryDescriptor<void> =>
	descriptor({
		kind: 'exec',
		name,
		sql,
		params: Object.freeze([]),
	});

const countQuirks = (): QueryDescriptor<number | null> =>
	descriptor({
		kind: 'one',
		name: 'CountQuirks',
		sql: 'SELECT count(*) AS total FROM quirks',
		params: Object.freeze([]),
		parse: (row: Record<string, unknown>) => row.total as number,
	});

const missingTable = (): QueryDescriptor<Record<string, unknown> | null> =>
	descriptor({
		kind: 'one',
		name: 'MissingTable',
		sql: 'SELECT id FROM definitely_missing',
		params: Object.freeze([]),
		parse: (row: Record<string, unknown>) => row,
	});

describe('native batch boundary against isolated Miniflare D1', () => {
	it('miniflare/batch-empty - rejects an unsafe empty batch synchronously before D1', () => {
		const db = new DB(env.DB);
		const unsafeBatch = db.batch as unknown as () => Promise<[]>;
		expect(() => unsafeBatch.call(db)).toThrowError(
			expect.objectContaining({
				name: 'QueryUsageError',
				operation: 'batch',
				expected: 'at least one generated query descriptor',
				received: 'no query descriptors',
			}),
		);
		expect(() => unsafeBatch.call(db)).toThrow(QueryUsageError);
	});

	it('miniflare/batch-native-rollback - passes a native failure through and observes local native rollback', async () => {
		const db = new DB(env.DB);
		const failure = await caught(() => db.batch(exec('RollbackProbe', 'INSERT INTO quirks (id, flag) VALUES (3600, 1)'), missingTable()));

		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(SqlcD1Error);
		expect((failure as Error).message).toMatch(/^D1_ERROR/);

		const stored = await env.DB.prepare('SELECT id FROM quirks WHERE id = 3600').first();
		// This is local Miniflare evidence; managed D1 rollback remains a release-gate scenario.
		expect(stored).toBeNull();
	});

	it('miniflare/batch-post-success-mapping - maps only after native success, exposes no tuple, and cannot roll back effects', async () => {
		const db = new DB(env.DB);
		const failure = await caught(() =>
			db.batch(exec('CommittedFirst', 'INSERT INTO quirks (id, flag) VALUES (3601, 1)'), createQuirk({ id: 3602 })),
		);

		expect(failure).toBeInstanceOf(QueryResultError);
		expect(failure).toMatchObject({
			operation: 'batch',
			queryName: 'CreateQuirk',
			batchIndex: 1,
			rowIndex: 0,
			path: 'flag',
		});

		const rows = await env.DB.prepare('SELECT id, flag FROM quirks WHERE id IN (3601, 3602) ORDER BY id').all<{
			id: number;
			flag: number;
		}>();
		expect(rows.results).toEqual([
			{ id: 3601, flag: 1 },
			{ id: 3602, flag: 2 },
		]);
		// Native success preceded local mapping failure, so this rejection does not imply retry safety.
	});
});

describe('session executors and bookmarks against isolated Miniflare D1', () => {
	it('miniflare/session-starts - accepts every starting form and exposes inherited execute and batch APIs', async () => {
		const db = new DB(env.DB);
		const sessions = [db.withSession(), db.withSession('first-primary'), db.withSession('first-unconstrained')];

		for (const session of sessions) {
			expect(['string', 'object']).toContain(typeof session.getBookmark());
			expect(await session.execute(countQuirks())).toEqual(expect.any(Number));
			const [count, nothing] = await session.batch(countQuirks(), exec('SessionNoop', 'UPDATE quirks SET flag = flag WHERE id = -1'));
			expect(count).toEqual(expect.any(Number));
			expect(nothing).toBeUndefined();
		}
	});

	it('miniflare/session-bookmark-transfer - transfers an opaque native bookmark locally when Miniflare provides one', async () => {
		const db = new DB(env.DB);
		const first = db.withSession('first-primary');
		await first.execute(exec('SessionWrite', 'INSERT INTO quirks (id, flag) VALUES (3610, 1)'));
		const bookmark = first.getBookmark();
		expect(bookmark === null || typeof bookmark === 'string').toBe(true);

		if (bookmark !== null) {
			const continued = db.withSession(bookmark);
			const stored = await continued.execute(
				descriptor<Record<string, unknown> | null>({
					kind: 'one',
					name: 'ReadSessionWrite',
					sql: 'SELECT id, flag FROM quirks WHERE id = 3610',
					params: Object.freeze([]),
					parse: (row: Record<string, unknown>) => row,
				}),
			);
			expect(stored).toEqual({ id: 3610, flag: 1 });
		}
	});

	it('miniflare/session-bookmark-after-failure - keeps bookmark delegation usable after post-success mapping failure', async () => {
		const session = new DB(env.DB).withSession('first-primary');
		const before = session.getBookmark();

		const failure = await caught(() => session.execute(createQuirk({ id: 3620 })));
		expect(failure).toBeInstanceOf(QueryResultError);
		expect(failure).toMatchObject({ operation: 'execute', queryName: 'CreateQuirk', rowIndex: 0 });

		const stored = await env.DB.prepare('SELECT flag FROM quirks WHERE id = 3620').first<{ flag: number }>();
		expect(stored).toEqual({ flag: 2 });

		const after = session.getBookmark();
		expect(after === null || typeof after === 'string').toBe(true);
		if (before !== null && after !== null) expect(after.length).toBeGreaterThan(0);
	});
});
