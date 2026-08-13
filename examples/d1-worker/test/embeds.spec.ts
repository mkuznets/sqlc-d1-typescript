import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DB } from "../src/runtime";
import {
	createFeed,
	createFile,
	createItem,
	deleteFeedsByUser,
	getFeedAndItemEmbed,
	listItemsWithFilesByIds,
	listItemsWithNotes,
	type CreateFeedArgs,
	type CreateFileArgs,
	type CreateItemArgs,
	type GetFeedAndItemEmbedRow,
} from "../src/queries_sql";

beforeAll(async () => {
	const schemaQueries = JSON.parse(env.TEST_SCHEMA_QUERIES) as string[];
	for (const query of schemaQueries) {
		await env.DB.prepare(query).run();
	}
});

const now = 1_760_000_000_000;

const feedArgs = (id: string, userId: string, title = "Feed title"): CreateFeedArgs => ({
	id,
	userId,
	type: "rss",
	title,
	link: "https://example.com/feed",
	authors: "Feed author",
	description: "A test feed",
	createdAt: now,
	updatedAt: now,
	deletedAt: null,
});

const fileArgs = (id: string, userId: string): CreateFileArgs => ({
	id,
	userId,
	itemId: null,
	size: 1024,
	mimeType: "audio/mpeg",
	hash: "hash",
	uploadUrl: "https://example.com/upload",
	createdAt: now,
	updatedAt: now,
	deletedAt: null,
});

const itemArgs = (id: string, feedId: string, userId: string, fileId: string): CreateItemArgs => ({
	id,
	feedId,
	userId,
	fileId,
	title: "Item title",
	description: "An item",
	link: "https://example.com/item",
	authors: "Item author",
	publishedAt: now,
	createdAt: now + 1,
	updatedAt: now + 2,
	deletedAt: null,
});

const note = async (itemId: string, text: string, rating: number): Promise<void> => {
	await env.DB.prepare("INSERT INTO item_notes (item_id, note, rating) VALUES (?, ?, ?)")
		.bind(itemId, text, rating)
		.run();
};

describe("embed reconstruction against real D1", () => {
	it("two embedded tables with colliding column names each keep their own values", async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs("feed_emb1", "user_emb", "Embedded feed")));
		await db.execute(createFile(fileArgs("file_emb1", "user_emb")));
		await db.execute(createItem(itemArgs("item_emb1", "feed_emb1", "user_emb", "file_emb1")));

		const row = await db.execute(getFeedAndItemEmbed({ id: "item_emb1" }));
		expect(row).not.toBeNull();
		const found = row as GetFeedAndItemEmbedRow;

		// feeds and items both project id, user_id, title, created_at and updated_at; a
		// private alias per embedded column is what keeps them apart.
		expect(found.feeds.id).toBe("feed_emb1");
		expect(found.items.id).toBe("item_emb1");
		expect(found.feeds.title).toBe("Embedded feed");
		expect(found.items.title).toBe("Item title");
		expect(found.feeds.createdAt).toBe(now);
		expect(found.items.createdAt).toBe(now + 1);
		expect(found.feeds.updatedAt).toBe(now);
		expect(found.items.updatedAt).toBe(now + 2);
		expect(found.feeds.userId).toBe("user_emb");
		expect(found.items.feedId).toBe("feed_emb1");
		expect(found.items.deletedAt).toBeNull();

		// The nested objects are plain and carry only generated public properties.
		expect(Object.keys(found)).toEqual(["feeds", "items"]);
		expect(Object.keys(found.feeds).some((key) => key.startsWith("d1_embed_"))).toBe(false);
		expect(Object.keys(found.items).some((key) => key.startsWith("d1_embed_"))).toBe(false);
		expect(Object.keys(found.feeds)).toEqual([
			"id", "userId", "type", "title", "link", "authors", "description", "createdAt", "updatedAt", "deletedAt",
		]);
	});

	it("an outer-join embed with no matching row is an object of nulls, never null", async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs("feed_emb2", "user_emb2")));
		await db.execute(createFile(fileArgs("file_emb2", "user_emb2")));
		await db.execute(createItem(itemArgs("item_emb2a", "feed_emb2", "user_emb2", "file_emb2")));
		await db.execute(createItem(itemArgs("item_emb2b", "feed_emb2", "user_emb2", "file_emb2")));
		await note("item_emb2a", "Worth keeping", 5);

		const rows = await db.execute(listItemsWithNotes({ feedId: "feed_emb2" }));
		expect(rows).toHaveLength(2);

		// An ordinary projected column sits beside the nested object.
		expect(rows[0].itemId).toBe("item_emb2a");
		expect(rows[0].itemNotes).toEqual({ itemId: "item_emb2a", note: "Worth keeping", rating: 5 });

		// The missing outer row is present as an object whose every field is null.
		expect(rows[1].itemId).toBe("item_emb2b");
		expect(rows[1].itemNotes).not.toBeNull();
		expect(rows[1].itemNotes).toEqual({ itemId: null, note: null, rating: null });
		expect(rows[1].itemNotes.rating).toBeNull();

		// Each row builds its own nested object.
		expect(rows[0].itemNotes).not.toBe(rows[1].itemNotes);
	});

	it("an embed composes with sqlc.slice expansion, for one element and for several", async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs("feed_emb3", "user_emb3")));
		await db.execute(createFile(fileArgs("file_emb3", "user_emb3")));
		for (const suffix of ["a", "b", "c"]) {
			await db.execute(createItem(itemArgs(`item_emb3${suffix}`, "feed_emb3", "user_emb3", "file_emb3")));
		}

		const one = await db.execute(listItemsWithFilesByIds({ ids: ["item_emb3b"] }));
		expect(one).toHaveLength(1);
		expect(one[0].items.id).toBe("item_emb3b");
		expect(one[0].files.id).toBe("file_emb3");
		expect(one[0].files.mimeType).toBe("audio/mpeg");
		expect(one[0].files.itemId).toBeNull();

		const three = await db.execute(listItemsWithFilesByIds({ ids: ["item_emb3a", "item_emb3b", "item_emb3c"] }));
		expect(three.map((row) => row.items.id)).toEqual(["item_emb3a", "item_emb3b", "item_emb3c"]);
		// items.id and files.id collide physically; the slice expansion leaves that intact.
		expect(three.every((row) => row.files.id === "file_emb3")).toBe(true);
		expect(three.every((row) => row.items.userId === "user_emb3")).toBe(true);
	});

	it("a batch mixes embed and exec-family descriptors and resolves them positionally", async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs("feed_emb4", "user_emb4")));
		await db.execute(createFile(fileArgs("file_emb4", "user_emb4")));
		await db.execute(createItem(itemArgs("item_emb4", "feed_emb4", "user_emb4", "file_emb4")));
		await note("item_emb4", "Batched", 3);
		await db.execute(createFeed(feedArgs("feed_emb4gone", "user_emb4gone")));

		const [single, listed, removed] = await db.batch(
			getFeedAndItemEmbed({ id: "item_emb4" }),
			listItemsWithNotes({ feedId: "feed_emb4" }),
			deleteFeedsByUser({ userId: "user_emb4gone" }),
		);
		expect(single?.feeds.id).toBe("feed_emb4");
		expect(single?.items.id).toBe("item_emb4");
		expect(listed).toHaveLength(1);
		expect(listed[0].itemNotes.note).toBe("Batched");
		expect(removed).toBe(1);
	});

	it("the SQL that reaches D1 carries the private aliases the parser reads", async () => {
		const db = new DB(env.DB);
		await db.execute(createFeed(feedArgs("feed_emb5", "user_emb5")));
		await db.execute(createFile(fileArgs("file_emb5", "user_emb5")));
		await db.execute(createItem(itemArgs("item_emb5", "feed_emb5", "user_emb5", "file_emb5")));

		const descriptor = getFeedAndItemEmbed({ id: "item_emb5" }) as unknown as { sql: string };
		expect(descriptor.sql).toContain('f.id AS "d1_embed_0_0"');
		expect(descriptor.sql).toContain('i.id AS "d1_embed_1_0"');
		// The rewrite only inserts aliases; sqlc's own text survives underneath.
		expect(descriptor.sql.replace(/ AS "d1_embed_[0-9_]+"/g, "")).toContain("SELECT f.id, f.user_id");

		// D1 keys its result objects by those aliases, and no public object exposes them.
		const raw = await env.DB.prepare(descriptor.sql).bind("item_emb5").first<Record<string, unknown>>();
		expect(raw).not.toBeNull();
		expect(Object.keys(raw ?? {})).toContain("d1_embed_0_0");
		expect(raw?.d1_embed_0_0).toBe("feed_emb5");
		expect(raw?.d1_embed_1_0).toBe("item_emb5");

		// The public row built from that same statement exposes no alias at all.
		const row = await db.execute(getFeedAndItemEmbed({ id: "item_emb5" })) as GetFeedAndItemEmbedRow;
		expect(Object.keys(row.items).some((key) => key.startsWith("d1_embed_"))).toBe(false);
		expect(row.items.id).toBe("item_emb5");
	});
});
