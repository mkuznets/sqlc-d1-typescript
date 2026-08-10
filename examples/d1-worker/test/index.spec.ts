import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

interface Step {
	step: string;
	[key: string]: unknown;
}

beforeAll(async () => {
	const schemaQueries = JSON.parse(env.TEST_SCHEMA_QUERIES) as string[];
	for (const query of schemaQueries) {
		await env.DB.prepare(query).run();
	}
});

describe("generated D1 queries", () => {
	it("executes one, insert-returning, many, exec, batch, and session queries", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(response.status).toBe(200);

		const entries = (await response.json()) as Step[];
		const steps = Object.fromEntries(entries.map((entry) => [entry.step, entry]));

		expect(steps.createFeed.feed).toMatchObject({
			userId: "user_1",
			title: "Test Feed",
			deletedAt: null,
		});
		expect(steps.descriptorReuse).toMatchObject({ descriptorFrozen: true });
		expect(steps.descriptorReuse.feedRead).toEqual(steps.createFeed.feed);
		expect(steps.descriptorReuse.feedReadAgain).toEqual(steps.descriptorReuse.feedRead);
		expect(steps.updateFeedUpdatedAt.feedAfterUpdate).toMatchObject({
			title: "Test Feed",
		});
		expect(steps.getFeedUserById.feedUser).toEqual({ userId: "user_1" });
		expect(steps.listFiles.count).toBe(2);
		expect(steps.getItemsByFeedId.count).toBe(2);
		expect(steps.updateItemById.itemUpdated).toMatchObject({
			title: "Episode 1 (Updated)",
			description: "First episode (revised)",
		});

		const joinedRows = steps.getItemsWithFilesByFeedId.itemsWithFiles as Array<
			Record<string, unknown>
		>;
		expect(joinedRows).toHaveLength(2);
		expect(joinedRows.every((row) => typeof row.joinedFileId === "string")).toBe(true);
		expect(steps.getItemWithFileById.singleItemWithFile).toMatchObject({
			fileSize: 1024,
			mimeType: "audio/mpeg",
		});

		expect(steps.batch).toMatchObject({
			batchItemsCount: 2,
			batchFilesCount: 2,
		});
		expect(steps.batchMixed.batchNewFile).toMatchObject({ mimeType: "image/png" });
		expect(steps.sessionExecute.sessionFeed).toEqual(steps.updateFeedUpdatedAt.feedAfterUpdate);
		expect(["string", "null"]).toContain(steps.sessionExecute.bookmarkType);
		expect(steps.sessionBatch).toMatchObject({
			sessionItemsCount: 2,
			sessionFilesCount: 3,
		});
	});
});
