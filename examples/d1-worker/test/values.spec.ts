import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DB, QueryResultError, SqlcD1Error, type QueryDescriptor } from "../src/runtime";
import {
	createQuirk,
	createSample,
	getSampleById,
	listSamples,
	type CreateSampleArgs,
} from "../src/queries_sql";

beforeAll(async () => {
	const schemaQueries = JSON.parse(env.TEST_SCHEMA_QUERIES) as string[];
	for (const query of schemaQueries) {
		await env.DB.prepare(query).run();
	}
});

const completeArgs = (overrides: Partial<CreateSampleArgs> = {}): CreateSampleArgs => ({
	intValue: 42,
	intNull: null,
	numValue: 12.5,
	numNull: null,
	textValue: "hello",
	textNull: null,
	boolValue: true,
	boolNull: null,
	blobValue: new Uint8Array([1, 2, 250]),
	blobNull: null,
	jsonValue: { nested: [1, "two", null, true] },
	jsonNull: null,
	anyValue: "opaque",
	anyNull: null,
	...overrides,
});

async function caught(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

describe("checked values against real D1", () => {
	it("round-trips every value kind through insert, one, and many", async () => {
		const db = new DB(env.DB);
		const inserted = await db.execute(createSample(completeArgs()));
		expect(inserted).not.toBeNull();
		expect(inserted).toMatchObject({
			intValue: 42,
			intNull: null,
			numValue: 12.5,
			numNull: null,
			textValue: "hello",
			textNull: null,
			boolValue: true,
			boolNull: null,
			anyValue: "opaque",
			anyNull: null,
		});
		// BOOLEAN does not round-trip as a boolean: D1 stores and returns 0/1.
		expect(inserted!.blobValue).toBeInstanceOf(Uint8Array);
		expect(Array.from(inserted!.blobValue)).toEqual([1, 2, 250]);
		expect(inserted!.jsonValue).toEqual({ nested: [1, "two", null, true] });
		expect(inserted!.jsonNull).toBeNull();

		const read = await db.execute(getSampleById({ id: inserted!.id }));
		expect(read).toEqual(inserted);

		const listed = await db.execute(listSamples());
		expect(listed.length).toBeGreaterThan(0);
		expect(listed.every((row) => row.blobValue instanceof Uint8Array)).toBe(true);
	});

	it("records the physical representations D1 actually returns", async () => {
		const db = new DB(env.DB);
		const inserted = await db.execute(createSample(completeArgs({
			boolValue: false,
			boolNull: true,
			blobNull: new Uint8Array([9]),
			jsonNull: [1, 2],
			anyValue: 7,
		})));
		const physical = await env.DB.prepare("SELECT * FROM samples WHERE id = ?")
			.bind(inserted!.id)
			.first<Record<string, unknown>>();

		// Pins the assumptions the row codecs are written against. rowBlob additionally
		// accepts Uint8Array and ArrayBuffer defensively; this is what actually arrives.
		expect(physical!.bool_value).toBe(0);
		expect(physical!.bool_null).toBe(1);
		expect(Array.isArray(physical!.blob_value)).toBe(true);
		expect(physical!.blob_value).toEqual([1, 2, 250]);
		expect(typeof physical!.json_value).toBe("string");
		expect(physical!.json_null).toBe("[1,2]");
		expect(typeof physical!.num_value).toBe("number");
		expect(physical!.any_value).toBe(7);

		expect(inserted!.boolValue).toBe(false);
		expect(inserted!.boolNull).toBe(true);
		expect(Array.from(inserted!.blobNull!)).toEqual([9]);
		expect(inserted!.jsonNull).toEqual([1, 2]);
	});

	it("rejects arguments synchronously, before D1 is reached", () => {
		expect(() => createSample(completeArgs({ intValue: 1.5 }))).toThrowError(
			expect.objectContaining({ name: "QueryArgumentError", operation: "construct", path: "intValue" }),
		);
		expect(() => createSample(completeArgs({ jsonValue: new Date() as never }))).toThrowError(
			expect.objectContaining({ name: "QueryArgumentError", path: "jsonValue" }),
		);
	});

	it("fails closed when a stored value contradicts the generated type", async () => {
		const db = new DB(env.DB);
		const insertContradiction = async (column: string, literal: string): Promise<number> => {
			const columns = ["int_value", "num_value", "text_value", "bool_value", "blob_value", "json_value", "any_value"];
			const values = columns.map((name) => (name === column ? literal : defaultLiteral(name)));
			const result = await env.DB
				.prepare(`INSERT INTO samples (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING id`)
				.first<{ id: number }>();
			return result!.id;
		};

		const stringInInteger = await insertContradiction("int_value", "'not a number'");
		const stringFailure = await caught(() => db.execute(getSampleById({ id: stringInInteger })));
		expect(stringFailure).toBeInstanceOf(QueryResultError);
		expect(stringFailure).toMatchObject({
			operation: "execute",
			queryName: "GetSampleById",
			rowIndex: 0,
			path: "intValue",
			expected: "a safe integer",
			received: "string",
		});

		const twoInBoolean = await insertContradiction("bool_value", "2");
		expect(await caught(() => db.execute(getSampleById({ id: twoInBoolean })))).toMatchObject({
			path: "boolValue",
			expected: "the integer 0 or 1",
			received: "number",
		});

		const malformedJson = await insertContradiction("json_value", "'{oops'");
		const jsonFailure = await caught(() => db.execute(getSampleById({ id: malformedJson })));
		expect(jsonFailure).toMatchObject({
			path: "jsonValue",
			expected: "JSON text",
			received: "malformed JSON string",
		});
		expect((jsonFailure as QueryResultError).cause).toBeInstanceOf(SyntaxError);

		// D1 rounds int64 values it cannot represent, so the mapper refuses them.
		const unsafeInteger = await insertContradiction("int_value", "9223372036854775807");
		expect(await caught(() => db.execute(getSampleById({ id: unsafeInteger })))).toMatchObject({
			path: "intValue",
			expected: "a safe integer",
			received: "unsafe integer",
		});
	});

	it("reports a mapping failure after the write has already committed", async () => {
		const db = new DB(env.DB);
		const failure = await caught(() => db.execute(createQuirk({ id: 1 })));
		expect(failure).toBeInstanceOf(QueryResultError);
		expect(failure).toMatchObject({
			operation: "execute",
			queryName: "CreateQuirk",
			path: "flag",
			expected: "the integer 0 or 1",
			received: "number",
		});
		expect("effectsMayHaveCommitted" in (failure as object)).toBe(false);
		expect(Object.getOwnPropertyNames(failure).some((name) => /commit|retry/i.test(name))).toBe(false);

		const survived = await env.DB.prepare("SELECT flag FROM quirks WHERE id = 1").first<{ flag: number }>();
		expect(survived).toEqual({ flag: 2 });
	});

	it("carries batchIndex, returns no partial tuple, and leaves batch writes committed", async () => {
		const db = new DB(env.DB);
		const failure = await caught(() => db.batch(
			createSample(completeArgs({ textValue: "batch-survivor" })),
			createQuirk({ id: 2 }),
		));
		expect(failure).toBeInstanceOf(QueryResultError);
		expect(failure).toMatchObject({
			operation: "batch",
			queryName: "CreateQuirk",
			batchIndex: 1,
			rowIndex: 0,
			path: "flag",
		});

		const survivors = await env.DB
			.prepare("SELECT count(*) AS total FROM samples WHERE text_value = 'batch-survivor'")
			.first<{ total: number }>();
		expect(survivors!.total).toBe(1);
		const quirk = await env.DB.prepare("SELECT flag FROM quirks WHERE id = 2").first<{ flag: number }>();
		expect(quirk).toEqual({ flag: 2 });
	});

	it("passes native D1 failures through untouched", async () => {
		const db = new DB(env.DB);

		const direct = await caught(() => env.DB.prepare("SELECT * FROM definitely_missing").all());
		expect(direct).toBeInstanceOf(Error);
		expect((direct as Error).message).toMatch(/^D1_ERROR/);
		expect(direct).not.toBeInstanceOf(SqlcD1Error);

		// The same holds through the generated executor: nothing wraps or reclassifies it.
		const throughExecutor = await caught(() => db.execute(missingTableDescriptor()));
		expect(throughExecutor).toBeInstanceOf(Error);
		expect(throughExecutor).not.toBeInstanceOf(SqlcD1Error);
		expect((throughExecutor as Error).message).toMatch(/^D1_ERROR/);
	});
});

// Descriptors are opaque to consumers, so provoking a native failure through the
// executor means hand-building one valid descriptor for a table that never exists.
function missingTableDescriptor(): QueryDescriptor<Record<string, unknown> | null> {
	return Object.freeze({
		kind: "one",
		name: "MissingTable",
		sql: "SELECT id FROM definitely_missing",
		params: Object.freeze([]),
		parse: (row: Record<string, unknown>) => row,
	}) as unknown as QueryDescriptor<Record<string, unknown> | null>;
}

function defaultLiteral(column: string): string {
	switch (column) {
		case "int_value": return "1";
		case "num_value": return "1.5";
		case "text_value": return "'text'";
		case "bool_value": return "1";
		case "blob_value": return "x'0102'";
		case "json_value": return "'{\"a\":1}'";
		default: return "'opaque'";
	}
}
