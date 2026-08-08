import {
	DB,
	createFeed,
	getFeedById,
	getFeedUserById,
	updateFeedUpdatedAt,
	createItem,
	getItemById,
	getItemsByFeedId,
	updateItemById,
	createFile,
	getFileById,
	getFileByIdForUser,
	listFiles,
	updateFileItemId,
	getItemsWithFilesByFeedId,
	getItemWithFileById,
} from "./queries_sql";

type Env = { DB: D1Database };

export default {
	async fetch(_request: Request, env: Env): Promise<Response> {
		const db = new DB(env.DB);
		const now = Date.now();
		const suffix = crypto.randomUUID().slice(0, 8);
		const feedId = `feed_${suffix}`;
		const fileId1 = `file_${suffix}a`;
		const fileId2 = `file_${suffix}b`;
		const fileId3 = `file_${suffix}c`;
		const itemId1 = `item_${suffix}a`;
		const itemId2 = `item_${suffix}b`;
		const log: unknown[] = [];

		// 1. Create a feed (INSERT RETURNING → OneInsertQuery)
		const feed = await db.execute(createFeed({
			id: feedId,
			userId: "user_1",
			type: "rss",
			title: "Test Feed",
			link: "https://example.com/feed",
			authors: "Author One",
			description: "A test feed",
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
		}));

		log.push({step: "createFeed", feed});

		// 2. Read feed back (SELECT → OneQuery)
		const feedRead = await db.execute(getFeedById({id: feedId}));
		log.push({step: "getFeedById", feedRead});

		// 3. Exec: update feed timestamp
		const newUpdatedAt = now + 1000;
		await db.execute(updateFeedUpdatedAt({id: feedId, updatedAt: newUpdatedAt}));
		const feedAfterUpdate = await db.execute(getFeedById({id: feedId}));
		log.push({step: "updateFeedUpdatedAt", feedAfterUpdate});

		// 4. GetFeedUserById (single-column select)
		const feedUser = await db.execute(getFeedUserById({id: feedId}));
		log.push({step: "getFeedUserById", feedUser});

		// 5. Create files
		const file1 = await db.execute(createFile({
			id: fileId1,
			userId: "user_1",
			itemId: null,
			size: 1024,
			mimeType: "audio/mpeg",
			hash: "abc123",
			uploadUrl: "https://cdn.example.com/file1.mp3",
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
		}));
		const file2 = await db.execute(createFile({
			id: fileId2,
			userId: "user_1",
			itemId: null,
			size: 2048,
			mimeType: "audio/ogg",
			hash: "def456",
			uploadUrl: "https://cdn.example.com/file2.ogg",
			createdAt: now + 1,
			updatedAt: now + 1,
			deletedAt: null,
		}));
		log.push({step: "createFiles", file1, file2});

		// 6. Read file back, and by user
		const fileRead = await db.execute(getFileById({id: fileId1}));
		const fileForUser = await db.execute(getFileByIdForUser({id: fileId1, userId: "user_1"}));
		log.push({step: "getFile", fileRead, fileForUser});

		// 7. ListFiles (ManyQuery, no args)
		const allFiles = await db.execute(listFiles());
		log.push({step: "listFiles", count: allFiles.length, allFiles});

		// 8. Create items linked to files
		const item1 = await db.execute(createItem({
			id: itemId1,
			feedId,
			userId: "user_1",
			fileId: fileId1,
			title: "Episode 1",
			description: "First episode",
			link: "https://example.com/ep1",
			authors: "Author One",
			publishedAt: now,
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
		}));
		const item2 = await db.execute(createItem({
			id: itemId2,
			feedId,
			userId: "user_1",
			fileId: fileId2,
			title: "Episode 2",
			description: "Second episode",
			link: "https://example.com/ep2",
			authors: "Author One",
			publishedAt: now + 100,
			createdAt: now + 100,
			updatedAt: now + 100,
			deletedAt: null,
		}));
		log.push({step: "createItems", item1, item2});

		// 9. Link files to items (exec)
		await db.execute(updateFileItemId({id: fileId1, itemId: itemId1}));
		await db.execute(updateFileItemId({id: fileId2, itemId: itemId2}));
		const fileAfterLink = await db.execute(getFileById({id: fileId1}));
		log.push({step: "updateFileItemId", fileAfterLink});

		// 10. GetItemById (OneQuery with multiple params)
		const itemRead = await db.execute(getItemById({id: itemId1, feedId}));
		log.push({step: "getItemById", itemRead});

		// 11. GetItemsByFeedId (ManyQuery)
		const items = await db.execute(getItemsByFeedId({feedId}));
		log.push({step: "getItemsByFeedId", count: items.length, items});

		// 12. UpdateItemById (exec) and verify
		await db.execute(updateItemById({
			id: itemId1,
			feedId,
			title: "Episode 1 (Updated)",
			description: "First episode (revised)",
			link: "https://example.com/ep1-v2",
			authors: "Author One, Author Two",
			publishedAt: now + 50,
			updatedAt: now + 500,
		}));
		const itemUpdated = await db.execute(getItemById({id: itemId1, feedId}));
		log.push({step: "updateItemById", itemUpdated});

		// 13. Join queries
		const itemsWithFiles = await db.execute(getItemsWithFilesByFeedId({feedId}));
		log.push({step: "getItemsWithFilesByFeedId", count: itemsWithFiles.length, itemsWithFiles});

		const singleItemWithFile = await db.execute(getItemWithFileById({id: itemId1}));
		log.push({step: "getItemWithFileById", singleItemWithFile});

		// 14. Batch mode
		const [batchFeed, batchItems, batchFiles] = await db.batch(
			getFeedById({id: feedId}),
			getItemsByFeedId({feedId}),
			listFiles(),
		);
		log.push({step: "batch", batchFeed, batchItemsCount: batchItems.length, batchFilesCount: batchFiles.length});

		// Batch with mixed query types (insert + select)
		const [batchNewFile, batchItem1] = await db.batch(
			createFile({
				id: fileId3,
				userId: "user_1",
				itemId: null,
				size: 4096,
				mimeType: "image/png",
				hash: "ghi789",
				uploadUrl: "https://cdn.example.com/file3.png",
				createdAt: now + 200,
				updatedAt: now + 200,
				deletedAt: null,
			}),
			getItemById({id: itemId1, feedId}),
		);
		log.push({step: "batchMixed", batchNewFile, batchItem1});

		// 15. Session mode
		const session = db.withSession("first-primary");

		const sessionFeed = await session.execute(getFeedById({id: feedId}));
		log.push({step: "sessionExecute", sessionFeed});

		const [sessionItems, sessionFiles] = await session.batch(
			getItemsByFeedId({feedId}),
			listFiles(),
		);
		log.push({step: "sessionBatch", sessionItemsCount: sessionItems.length, sessionFilesCount: sessionFiles.length});

		return Response.json(log, {headers: {"content-type": "application/json"}});
	},
};
