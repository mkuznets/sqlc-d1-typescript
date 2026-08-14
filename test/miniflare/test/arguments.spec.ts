import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DB, QueryArgumentError } from '../src/runtime';
import {
	copySampleForTextValues,
	createFeed,
	deleteFeedsByIdsForUser,
	deleteSamplesByTextValues,
	getFeedByIdAndUser,
	getFirstFeedByIds,
	insertSampleId,
	listFeedsByIds,
	listFeedsByOptionalTitle,
	touchFeedsByIds,
	type CreateFeedArgs,
	type InsertSampleIdArgs,
} from '../src/queries_sql';

const now = 1_760_000_000_000;

const feedArgs = (id: string, userId: string, title = 'Original'): CreateFeedArgs => ({
	id,
	userId,
	type: 'rss',
	title,
	link: 'https://example.com/feed',
	authors: 'Author One',
	description: 'A test feed',
	createdAt: now,
	updatedAt: now,
	deletedAt: null,
});

const sampleArgs = (textValue: string, intValue = 1): InsertSampleIdArgs => ({
	intValue,
	intNull: null,
	numValue: 1.5,
	numNull: null,
	textValue,
	textNull: null,
	boolValue: true,
	boolNull: null,
	blobValue: new Uint8Array([1, 2, 3]),
	blobNull: null,
	jsonValue: { nested: [1, 'two'] },
	jsonNull: null,
	anyValue: 'opaque',
	anyNull: null,
});

const feedIds = async (userId: string): Promise<string[]> => {
	const rows = await env.DB.prepare('SELECT id FROM feeds WHERE user_id = ? ORDER BY id').bind(userId).all<{ id: string }>();
	return rows.results.map((row) => row.id);
};

describe('argument model against real D1', () => {
	it('miniflare/argument-arg - a repeated sqlc.arg is one property bound once', async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs('feed_rep1', 'user_rep')));
		await db.execute(createFeed(feedArgs('feed_rep2', 'user_other')));

		const mine = await db.execute(getFeedByIdAndUser({ id: 'feed_rep1', userId: 'user_rep' }));
		expect(mine).toMatchObject({ id: 'feed_rep1', userId: 'user_rep' });

		// The second occurrence of ?2 sees the same bound value.
		expect(await db.execute(getFeedByIdAndUser({ id: 'feed_rep2', userId: '' }))).toMatchObject({ id: 'feed_rep2' });
		expect(await db.execute(getFeedByIdAndUser({ id: 'feed_rep2', userId: 'user_rep' }))).toBeNull();
	});

	it('miniflare/argument-narg - a sqlc.narg argument accepts null and a value, and is never optional', async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs('feed_narg1', 'user_narg', 'Wanted')));
		await db.execute(createFeed(feedArgs('feed_narg2', 'user_narg', 'Other')));

		const matching = await db.execute(listFeedsByOptionalTitle({ title: 'Wanted' }));
		expect(matching.map((row) => row.id)).toEqual(['feed_narg1']);

		// NULL is a value the query sees, not an absent argument.
		const all = await db.execute(listFeedsByOptionalTitle({ title: null }));
		expect(all.map((row) => row.id)).toEqual(['feed_narg1', 'feed_narg2']);

		// A nullable argument is a required property; omission and undefined are rejected
		// by the compiler above and by the factory below.
		// @ts-expect-error every argument property is required
		expect(() => listFeedsByOptionalTitle({})).toThrowError(QueryArgumentError);
		// @ts-expect-error undefined is never a SQL NULL
		expect(() => listFeedsByOptionalTitle({ title: undefined })).toThrowError(QueryArgumentError);
	});

	it('miniflare/argument-slice - a slice binds exactly its elements, for any length', async () => {
		const db = new DB(env.DB);
		for (const index of [1, 2, 3, 4]) {
			await db.execute(createFeed(feedArgs(`feed_slice${index}`, 'user_slice')));
		}

		for (const ids of [['feed_slice1'], ['feed_slice1', 'feed_slice3'], ['feed_slice1', 'feed_slice2', 'feed_slice4']]) {
			const rows = await db.execute(listFeedsByIds({ ids }));
			expect(rows.map((row) => row.id)).toEqual(ids);
		}
		// An id outside the slice is not matched, and a repeated element is harmless.
		expect((await db.execute(listFeedsByIds({ ids: ['feed_slice2', 'feed_slice2'] }))).map((row) => row.id)).toEqual(['feed_slice2']);
		expect(await db.execute(listFeedsByIds({ ids: ['feed_absent'] }))).toEqual([]);

		// The caller's array is snapshotted at construction.
		const mutable = ['feed_slice1'];
		const descriptor = listFeedsByIds({ ids: mutable });
		mutable.push('feed_slice2');
		expect((await db.execute(descriptor)).map((row) => row.id)).toEqual(['feed_slice1']);
	});

	it('miniflare/argument-bind-order - binds a positional argument before the slice it precedes in the text', async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs('feed_order1', 'user_order')));
		await db.execute(createFeed(feedArgs('feed_order2', 'user_order')));
		await db.execute(createFeed(feedArgs('feed_order3', 'user_intruder')));

		// If user_id and the slice were bound in the other order, this would delete nothing.
		const removed = await db.execute(
			deleteFeedsByIdsForUser({
				userId: 'user_order',
				ids: ['feed_order1', 'feed_order2', 'feed_order3'],
			}),
		);
		expect(removed).toBe(2);
		expect(await feedIds('user_order')).toEqual([]);
		expect(await feedIds('user_intruder')).toEqual(['feed_order3']);
	});

	it('miniflare/argument-empty-slice - an empty slice is rejected before any statement reaches D1', async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs('feed_empty1', 'user_empty')));

		expect(() => deleteFeedsByIdsForUser({ userId: 'user_empty', ids: [] })).toThrowError(QueryArgumentError);
		try {
			deleteFeedsByIdsForUser({ userId: 'user_empty', ids: [] });
		} catch (error) {
			const failure = error as QueryArgumentError;
			expect(failure.operation).toBe('construct');
			expect(failure.queryName).toBe('DeleteFeedsByIdsForUser');
			expect(failure.path).toBe('ids');
			expect(failure.expected).toBe('a non-empty array');
			expect(failure.received).toBe('an empty array');
		}

		// No NULL substitution, no constant rewrite: the database is untouched.
		expect(await feedIds('user_empty')).toEqual(['feed_empty1']);
		// The factory throws while the batch's arguments are still being evaluated.
		await expect(async () =>
			db.batch(touchFeedsByIds({ updatedAt: now + 1, ids: ['feed_empty1'] }), deleteFeedsByIdsForUser({ userId: 'user_empty', ids: [] })),
		).rejects.toThrowError(QueryArgumentError);
		const untouched = await env.DB.prepare("SELECT updated_at FROM feeds WHERE id = 'feed_empty1'").first<{ updated_at: number }>();
		expect(untouched!.updated_at).toBe(now);
		expect(await feedIds('user_empty')).toEqual(['feed_empty1']);
	});

	it('miniflare/argument-slice-commands - expands a slice for every ordinary command', async () => {
		const db = new DB(env.DB);
		for (const index of [1, 2, 3]) {
			await db.execute(createFeed(feedArgs(`feed_cmd${index}`, 'user_cmd')));
		}
		await db.execute(insertSampleId(sampleArgs('cmd-sample-a', 11)));
		await db.execute(insertSampleId(sampleArgs('cmd-sample-b', 12)));

		// :one
		const first = await db.execute(getFirstFeedByIds({ ids: ['feed_cmd3', 'feed_cmd2'] }));
		expect(first).toMatchObject({ id: 'feed_cmd2' });

		// :many
		expect((await db.execute(listFeedsByIds({ ids: ['feed_cmd1', 'feed_cmd3'] }))).map((row) => row.id)).toEqual([
			'feed_cmd1',
			'feed_cmd3',
		]);

		// :exec
		expect(await db.execute(touchFeedsByIds({ updatedAt: now + 5, ids: ['feed_cmd1', 'feed_cmd2'] }))).toBeUndefined();
		const touched = await env.DB.prepare('SELECT id FROM feeds WHERE updated_at = ? ORDER BY id')
			.bind(now + 5)
			.all<{ id: string }>();
		expect(touched.results.map((row) => row.id)).toEqual(['feed_cmd1', 'feed_cmd2']);

		// :execlastid
		const copied = await db.execute(
			copySampleForTextValues({
				textValue: 'cmd-sample-copy',
				values: ['cmd-sample-a', 'cmd-sample-b'],
			}),
		);
		expect(Number.isSafeInteger(copied)).toBe(true);
		const copiedRow = await env.DB.prepare('SELECT text_value, int_value FROM samples WHERE id = ?')
			.bind(copied)
			.first<{ text_value: string; int_value: number }>();
		expect(copiedRow).toEqual({ text_value: 'cmd-sample-copy', int_value: 11 });

		// :execresult
		const native = await db.execute(deleteSamplesByTextValues({ values: ['cmd-sample-a', 'cmd-sample-copy'] }));
		expect(native.meta.changes).toBe(2);
		expect(native.results.map((row) => row.text_value).sort()).toEqual(['cmd-sample-a', 'cmd-sample-copy']);

		// :execrows
		expect(await db.execute(deleteFeedsByIdsForUser({ userId: 'user_cmd', ids: ['feed_cmd1', 'feed_cmd2', 'feed_cmd3'] }))).toBe(3);
	});

	it('miniflare/interaction-slice-batch - carries slice descriptors of different lengths through one native batch', async () => {
		const db = new DB(env.DB);
		for (const index of [1, 2, 3, 4]) {
			await db.execute(createFeed(feedArgs(`feed_batch${index}`, 'user_argbatch')));
		}
		await db.execute(insertSampleId(sampleArgs('batch-sample', 31)));

		const [listed, first, nothing, matching, removed] = await db.batch(
			listFeedsByIds({ ids: ['feed_batch1', 'feed_batch2', 'feed_batch3'] }),
			getFirstFeedByIds({ ids: ['feed_batch4'] }),
			touchFeedsByIds({ updatedAt: now + 9, ids: ['feed_batch1'] }),
			listFeedsByOptionalTitle({ title: null }),
			deleteFeedsByIdsForUser({ userId: 'user_argbatch', ids: ['feed_batch2', 'feed_batch3'] }),
		);

		expect(listed.map((row) => row.id)).toEqual(['feed_batch1', 'feed_batch2', 'feed_batch3']);
		expect(first).toMatchObject({ id: 'feed_batch4' });
		expect(nothing).toBeUndefined();
		expect(matching.length).toBeGreaterThanOrEqual(4);
		expect(removed).toBe(2);
		expect(await feedIds('user_argbatch')).toEqual(['feed_batch1', 'feed_batch4']);
	});

	it('miniflare/argument-hostile-values - binds slice elements as data, never as SQL text', async () => {
		const db = new DB(env.DB);
		const hostile = ["' OR 1=1 --", '?1', '/*SLICE:values*/?', "'); DROP TABLE samples; --"];
		for (const value of hostile) {
			await db.execute(insertSampleId(sampleArgs(value, 41)));
		}
		await db.execute(insertSampleId(sampleArgs('untouched', 42)));

		const deleted = await db.execute(deleteSamplesByTextValues({ values: hostile }));
		expect(deleted.meta.changes).toBe(hostile.length);
		expect(deleted.results.map((row) => row.text_value).sort()).toEqual([...hostile].sort());

		// The statement was not altered: the row outside the slice survived.
		const survivors = await env.DB.prepare('SELECT text_value FROM samples ORDER BY id').all<{ text_value: string }>();
		expect(survivors.results.map((row) => row.text_value)).toEqual(['untouched']);
	});
});
