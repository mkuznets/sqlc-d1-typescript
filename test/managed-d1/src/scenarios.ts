import { DB, QueryResultError, SqlcD1Error } from "../../miniflare/src/runtime";
import {
  createFeed, createItem, createQuirk, createSample, deleteFeedsByUser, deleteSamplesResult,
  getFeedAndItemEmbed, getFeedById, getFeedByIdAndUser, getSampleById, insertSampleId,
  listFeedsByIds, listFeedsByOptionalTitle, listSamples, updateFeedUpdatedAt,
} from "../../miniflare/src/queries_sql";
import { MANAGED_SCENARIO_IDS, type ScenarioRegistry } from "./protocol";
function assert(condition: unknown): asserts condition { if (!condition) throw new Error("scenario assertion failed"); }
const feed = (id: string, userId: string) => ({ id, userId, type: "rss", title: `title-${id}`, link: "https://example.invalid", authors: "author", description: "description", createdAt: 1, updatedAt: 1, deletedAt: null });
const sample = (textValue: string) => ({ intValue: 7, intNull: null, numValue: 1.5, numNull: null, textValue, textNull: null, boolValue: true, boolNull: null, blobValue: new Uint8Array([1, 2, 3]), blobNull: null, jsonValue: { ok: true }, jsonNull: null, anyValue: "opaque", anyNull: null });
async function caught(run: () => Promise<unknown>): Promise<unknown> { try { await run(); } catch (error) { return error; } throw new Error("expected rejection"); }

export const managedScenarios: ScenarioRegistry = Object.freeze({
  "managed-d1/value-command-metadata": async (binding) => {
    const db = new DB(binding); const created = await db.execute(createSample(sample("managed-values"))); assert(created?.boolValue === true && created.intNull === null && created.blobValue instanceof Uint8Array);
    assert((await db.execute(getSampleById({ id: created.id })))?.textValue === "managed-values"); assert((await db.execute(listSamples())).length >= 1);
    await db.execute(updateFeedUpdatedAt({ updatedAt: 2, id: "feed_absent" }));
    assert(await db.execute(deleteFeedsByUser({ userId: "absent" })) === 0);
    assert(Number.isSafeInteger(await db.execute(insertSampleId(sample("managed-last-id")))));
    const raw = await db.execute(deleteSamplesResult({ textValue: "managed-values" })); assert(typeof raw.success === "boolean" && typeof raw.meta === "object");
  },
  "managed-d1/macro-smoke": async (binding) => {
    const db = new DB(binding); await db.execute(createFeed(feed("feed_macro_a", "user_macro"))); await db.execute(createFeed(feed("feed_macro_b", "user_macro")));
    assert((await db.execute(getFeedByIdAndUser({ id: "feed_macro_a", userId: "user_macro" })))?.id === "feed_macro_a");
    assert((await db.execute(listFeedsByOptionalTitle({ title: null }))).length >= 2); assert((await db.execute(listFeedsByIds({ ids: ["feed_macro_a", "feed_macro_b"] }))).length === 2);
    await db.execute(createItem({ id: "item_macro_a", feedId: "feed_macro_a", userId: "user_macro", fileId: "file_unused", title: "item", description: "d", link: "l", authors: "a", publishedAt: 1, createdAt: 1, updatedAt: 1, deletedAt: null }));
    const embedded = await db.execute(getFeedAndItemEmbed({ id: "item_macro_a" })); assert(embedded !== null && embedded.feeds.id === "feed_macro_a" && embedded.items.id === "item_macro_a");
  },
  "managed-d1/batch-success": async (binding) => {
    const db = new DB(binding); const [created, nothing] = await db.batch(createFeed(feed("feed_batch_ok", "user_batch")), updateFeedUpdatedAt({ updatedAt: 3, id: "feed_batch_ok" }));
    assert(created?.id === "feed_batch_ok" && nothing === undefined && (await db.execute(getFeedById({ id: "feed_batch_ok" })))?.updatedAt === 3);
  },
  "managed-d1/batch-rollback": async (binding) => {
    const db = new DB(binding); const error = await caught(() => db.batch(createFeed(feed("feed_rollback", "user_rollback")), createFeed(feed("feed_rollback", "user_rollback"))));
    assert(error instanceof Error && !(error instanceof SqlcD1Error)); assert(await db.execute(getFeedById({ id: "feed_rollback" })) === null);
  },
  "managed-d1/direct-session": async (binding) => {
    const db = new DB(binding); await db.execute(createFeed(feed("feed_direct", "user_session"))); assert((await db.withSession("first-primary").execute(getFeedById({ id: "feed_direct" })))?.id === "feed_direct");
  },
  "managed-d1/bookmark-transfer": async (binding) => {
    const db = new DB(binding); const first = db.withSession("first-primary"); await first.execute(createFeed(feed("feed_bookmark", "user_bookmark"))); const bookmark = first.getBookmark(); assert(typeof bookmark === "string" && bookmark.length > 0); assert((await db.withSession(bookmark as string).execute(getFeedById({ id: "feed_bookmark" })))?.id === "feed_bookmark");
  },
  "managed-d1/native-error-identity": async (binding) => {
    const db = new DB(binding); await db.execute(createFeed(feed("feed_unique", "user_native"))); const error = await caught(() => db.execute(createFeed(feed("feed_unique", "user_native")))); assert(error instanceof Error && !(error instanceof SqlcD1Error));
  },
  "managed-d1/post-execution-result-error": async (binding) => {
    const db = new DB(binding); const error = await caught(() => db.execute(createQuirk({ id: 4002 }))); assert(error instanceof QueryResultError);
    const duplicate = await caught(() => db.execute(createQuirk({ id: 4002 }))); assert(duplicate instanceof Error && !(duplicate instanceof SqlcD1Error));
  },
});
assert(Object.keys(managedScenarios).every((id, index) => id === MANAGED_SCENARIO_IDS[index]));
