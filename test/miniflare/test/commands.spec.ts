import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DB } from "../src/runtime";
import {
  createFeed,
  deleteFeedsByUser,
  deleteSamplesResult,
  deleteSamplesReturning,
  getFeedById,
  insertSampleId,
  listSamples,
  renameFeedsReturning,
  updateFeedUpdatedAt,
  type CreateFeedArgs,
  type InsertSampleIdArgs,
} from "../src/queries_sql";

const now = 1_760_000_000_000;

const feedArgs = (id: string, userId: string, title = "Original"): CreateFeedArgs => ({
  id,
  userId,
  type: "rss",
  title,
  link: "https://example.com/feed",
  authors: "Author One",
  description: "A test feed",
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
  jsonValue: { nested: [1, "two"] },
  jsonNull: null,
  anyValue: "opaque",
  anyNull: null,
});

describe("ordinary command semantics against real D1", () => {
  it("miniflare/command-execrows - :execrows returns the count D1 actually changed, zero included", async () => {
    const db = new DB(env.DB);
    await db.execute(createFeed(feedArgs("feed_rows1", "user_rows")));
    await db.execute(createFeed(feedArgs("feed_rows2", "user_rows")));

    const changed = await db.execute(deleteFeedsByUser({ userId: "user_rows" }));
    expect(changed).toBe(2);

    // A statement that matches nothing is a successful zero, not a failure.
    expect(await db.execute(deleteFeedsByUser({ userId: "user_absent" }))).toBe(0);
  });

  it("miniflare/command-execlastid - :execlastid returns a rowid a follow-up read confirms", async () => {
    const db = new DB(env.DB);
    const first = await db.execute(insertSampleId(sampleArgs("lastid-a")));
    const second = await db.execute(insertSampleId(sampleArgs("lastid-b")));
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(second).toBeGreaterThan(first);

    const stored = await env.DB.prepare("SELECT text_value FROM samples WHERE id = ?")
      .bind(second)
      .first<{ text_value: string }>();
    expect(stored).toEqual({ text_value: "lastid-b" });
  });

  it("miniflare/command-execresult - :execresult hands back the native result untouched", async () => {
    const db = new DB(env.DB);
    await db.execute(insertSampleId(sampleArgs("native-1")));
    await db.execute(insertSampleId(sampleArgs("native-2")));

    const result = await db.execute(deleteSamplesResult({ textValue: "native-1" }));
    expect(result.success).toBe(true);
    expect(result.meta.changes).toBe(1);
    expect(Number.isSafeInteger(result.meta.last_row_id)).toBe(true);

    // RETURNING rows arrive as D1's own physical records, unmapped and unrenamed.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ text_value: "native-1", bool_value: 1 });

    // The Plugin neither copies nor freezes what D1 owns.
    expect(Object.isFrozen(result)).toBe(false);
    expect(Object.isFrozen(result.results)).toBe(false);

    const survivor = await env.DB.prepare("SELECT count(*) AS total FROM samples WHERE text_value = 'native-2'").first<{
      total: number;
    }>();
    expect(survivor!.total).toBe(1);
  });

  it("miniflare/command-one-returning - :one over DML with RETURNING maps the first row and the write persists", async () => {
    const db = new DB(env.DB);
    await db.execute(createFeed(feedArgs("feed_ret1", "user_ret")));
    await db.execute(createFeed(feedArgs("feed_ret2", "user_ret")));

    const renamed = await db.execute(renameFeedsReturning({ title: "Renamed", userId: "user_ret" }));
    expect(renamed).not.toBeNull();
    expect(renamed).toMatchObject({ userId: "user_ret", title: "Renamed" });

    // A multi-row UPDATE ... RETURNING yields one row, and every match is written.
    const both = await env.DB.prepare("SELECT id, title FROM feeds WHERE user_id = 'user_ret' ORDER BY id").all<{
      id: string;
      title: string;
    }>();
    expect(both.results).toEqual([
      { id: "feed_ret1", title: "Renamed" },
      { id: "feed_ret2", title: "Renamed" },
    ]);

    // first() yields the first RETURNING row, which SQLite emits in rowid order.
    expect(renamed!.id).toBe("feed_ret1");
  });

  it("miniflare/command-empty-results - :one with no matching row is null and :many with none is an empty array", async () => {
    const db = new DB(env.DB);
    expect(await db.execute(getFeedById({ id: "feed_absent" }))).toBeNull();
    expect(await db.execute(renameFeedsReturning({ title: "Unused", userId: "user_absent" }))).toBeNull();
    expect(await db.execute(deleteSamplesReturning({ textValue: "absent" }))).toEqual([]);
  });

  it("miniflare/command-many-returning - :many over DELETE with RETURNING maps every deleted row", async () => {
    const db = new DB(env.DB);
    await db.execute(insertSampleId(sampleArgs("many-delete", 7)));
    await db.execute(insertSampleId(sampleArgs("many-delete", 8)));

    const deleted = await db.execute(deleteSamplesReturning({ textValue: "many-delete" }));
    expect(deleted).toHaveLength(2);
    expect(deleted.map((row) => row.intValue).sort()).toEqual([7, 8]);
    expect(deleted.every((row) => row.blobValue instanceof Uint8Array)).toBe(true);

    const remaining = await env.DB.prepare(
      "SELECT count(*) AS total FROM samples WHERE text_value = 'many-delete'",
    ).first<{
      total: number;
    }>();
    expect(remaining!.total).toBe(0);
  });

  it("miniflare/command-all-batch - resolves all six commands from one native batch, positionally", async () => {
    const db = new DB(env.DB);
    await db.execute(createFeed(feedArgs("feed_batch1", "user_batch")));
    await db.execute(createFeed(feedArgs("feed_batch2", "user_batch")));
    await db.execute(insertSampleId(sampleArgs("batch-delete", 21)));

    const [feed, samples, nothing, changed, lastId, native] = await db.batch(
      getFeedById({ id: "feed_batch1" }),
      listSamples(),
      updateFeedUpdatedAt({ updatedAt: now + 1, id: "feed_batch1" }),
      deleteFeedsByUser({ userId: "user_batch" }),
      insertSampleId(sampleArgs("batch-inserted", 22)),
      deleteSamplesResult({ textValue: "batch-delete" }),
    );

    expect(feed).toMatchObject({ id: "feed_batch1", userId: "user_batch" });
    expect(samples.length).toBeGreaterThan(0);
    expect(nothing).toBeUndefined();
    expect(changed).toBe(2);
    expect(Number.isSafeInteger(lastId)).toBe(true);
    expect(native.meta.changes).toBe(1);
    expect(native.results[0]).toMatchObject({ text_value: "batch-delete", int_value: 21 });

    const inserted = await env.DB.prepare("SELECT text_value FROM samples WHERE id = ?")
      .bind(lastId)
      .first<{ text_value: string }>();
    expect(inserted).toEqual({ text_value: "batch-inserted" });
  });
});
