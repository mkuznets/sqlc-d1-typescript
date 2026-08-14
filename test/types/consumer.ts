export const publicTypesConsumer = `import {
  DB, type QueryDescriptor, QueryExecutor, SessionExecutor,
  type D1NonNullValue, type D1Value, type JsonValue,
  SqlcD1Error, type SqlcD1ErrorContext, QueryArgumentError, QueryUsageError, QueryResultError,
} from "./runtime";
import {
  getFeed, createFeed, listFeeds, touchFeed, deleteFeedsByUser, insertFeedId, purgeFeeds,
  searchByNickname, deleteUsersByIds, userAndPost, embedValues,
  type GetFeedArgs, type GetFeedRow, type CreateFeedArgs, type CreateFeedRow, type ListFeedsRow,
  type SearchByNicknameArgs, type DeleteUsersByIdsArgs, type UserAndPostRow, type EmbedValuesRow,
} from "./queries_sql";
import { createSample, getSample, listSamples, type CreateSampleArgs, type CreateSampleRow, type GetSampleRow, type ListSamplesRow } from "./values_sql";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type DescriptorResult<Q> = Q extends QueryDescriptor<infer Result> ? Result : never;
type _GetArgs = Expect<Equal<Parameters<typeof getFeed>, [args: GetFeedArgs]>>;
type _GetArgsShape = Expect<Equal<GetFeedArgs, { id: number }>>;
type _CreateArgs = Expect<Equal<Parameters<typeof createFeed>, [args: CreateFeedArgs]>>;
type _CreateArgsShape = Expect<Equal<CreateFeedArgs, { title: string }>>;
type _NullableArgs = Expect<Equal<SearchByNicknameArgs, { nick: string | null }>>;
type _SliceFactoryArgs = Expect<Equal<Parameters<typeof deleteUsersByIds>, [args: DeleteUsersByIdsArgs]>>;
type _SliceArgs = Expect<Equal<DeleteUsersByIdsArgs, { ids: ReadonlyArray<number> }>>;
type _SliceResult = Expect<Equal<DescriptorResult<ReturnType<typeof deleteUsersByIds>>, number>>;
type _OneResult = Expect<Equal<DescriptorResult<ReturnType<typeof getFeed>>, GetFeedRow | null>>;
type _InsertResult = Expect<Equal<DescriptorResult<ReturnType<typeof createFeed>>, CreateFeedRow | null>>;
type _ManyResult = Expect<Equal<DescriptorResult<ReturnType<typeof listFeeds>>, ListFeedsRow[]>>;
type _ExecResult = Expect<Equal<DescriptorResult<ReturnType<typeof touchFeed>>, void>>;
type _ExecRowsResult = Expect<Equal<DescriptorResult<ReturnType<typeof deleteFeedsByUser>>, number>>;
type _ExecLastIdResult = Expect<Equal<DescriptorResult<ReturnType<typeof insertFeedId>>, number>>;
type _ExecNativeResult = Expect<Equal<DescriptorResult<ReturnType<typeof purgeFeeds>>, D1Result<Record<string, unknown>>>>;
type _EmbeddedUsers = Expect<Equal<UserAndPostRow["users"], { id: number; name: string }>>;
type _EmbeddedBlob = Expect<Equal<EmbedValuesRow["samples"]["blobNull"], Uint8Array | null>>;
type _IntegerRow = Expect<Equal<GetSampleRow["intValue"], number>>;
type _BooleanRow = Expect<Equal<GetSampleRow["boolValue"], boolean>>;
type _JsonRow = Expect<Equal<GetSampleRow["jsonValue"], unknown>>;
type _BlobRow = Expect<Equal<GetSampleRow["blobValue"], Uint8Array>>;

declare const binding: D1Database;
const db = new DB(binding);

const one: Promise<GetFeedRow | null> = db.execute(getFeed({ id: 1 }));
const inserted: Promise<CreateFeedRow | null> = db.execute(createFeed({ title: "x" }));
const many: Promise<ListFeedsRow[]> = db.execute(listFeeds());
const nothing: Promise<void> = db.execute(touchFeed({ title: "x", id: 1 }));
const changed: Promise<number> = db.execute(deleteFeedsByUser({ userId: "u" }));
const sliceChanged: Promise<number> = db.execute(deleteUsersByIds({ ids: [1, 2] }));
const lastId: Promise<number> = db.execute(insertFeedId({ title: "x" }));
const native: Promise<D1Result<Record<string, unknown>>> = db.execute(purgeFeeds({ userId: "u" }));

const tuple = db.batch(getFeed({id:1}), createFeed({title:"x"}), listFeeds(), touchFeed({title:"x",id:1}), deleteFeedsByUser({userId:"u"}), insertFeedId({title:"x"}), purgeFeeds({userId:"u"}));
type _BatchTuple = Expect<Equal<Awaited<typeof tuple>, [GetFeedRow | null, CreateFeedRow | null, ListFeedsRow[], void, number, number, D1Result<Record<string, unknown>>]>>;
const sideEffects: QueryDescriptor<void>[] = [touchFeed({title:"updated",id:1})];
const typedHeadAndTail = db.batch(getFeed({id:1}), ...sideEffects);
type _TypedHeadAndTail = Expect<Equal<Awaited<typeof typedHeadAndTail>, [GetFeedRow | null, ...void[]]>>;
const [typedHead] = await typedHeadAndTail;
type _TypedHead = Expect<Equal<typeof typedHead, GetFeedRow | null>>;

const session = db.withSession("bookmark");
const directExecutor: QueryExecutor = db;
const sessionExecutor: QueryExecutor = session;
const directResult: Promise<GetFeedRow | null> = directExecutor.execute(getFeed({id:1}));
const sessionResult: Promise<GetFeedRow | null> = sessionExecutor.execute(getFeed({id:1}));
const sessionTuple: Promise<[GetFeedRow | null, ListFeedsRow[]]> = session.batch(getFeed({id:1}), listFeeds());
const bookmark: string | null = session.getBookmark();

const values: D1NonNullValue[] = [true, 1, "x", new Uint8Array()];
const nullable: D1Value = null;
const json: JsonValue = { nested: [null, true, 1, "x"] };

const complete: CreateSampleArgs = { intValue:1,intNull:null,numValue:1.5,numNull:null,textValue:"x",textNull:null,boolValue:true,boolNull:null,blobValue:new Uint8Array(),blobNull:null,jsonValue:{x:true},jsonNull:null,anyValue:"opaque",anyNull:null };
const sampleOne: Promise<CreateSampleRow | null> = db.execute(createSample(complete));
const sampleRead: Promise<GetSampleRow | null> = db.execute(getSample({intValue:1}));
const sampleMany: Promise<ListSamplesRow[]> = db.execute(listSamples());

const context: SqlcD1ErrorContext = { operation:"execute", queryName:"GetFeed", batchIndex:0, rowIndex:0, path:"id", expected:"safe integer", received:"string", cause:new Error("cause") };
const errors: SqlcD1Error[] = [new QueryArgumentError("x", context), new QueryUsageError("x", context), new QueryResultError("x", context)];
const operation: "construct" | "execute" | "batch" | "withSession" = errors[0].operation;
const fields: (string | number | unknown | undefined)[] = [errors[0].queryName, errors[0].batchIndex, errors[0].rowIndex, errors[0].path, errors[0].expected, errors[0].received, errors[0].cause];

void [one,inserted,many,nothing,changed,sliceChanged,lastId,native,tuple,typedHead,directResult,sessionResult,sessionTuple,bookmark,values,nullable,json,sampleOne,sampleRead,sampleMany,operation,fields,userAndPost({id:1}),embedValues({intValue:1})];

// @ts-expect-error nullable properties remain required
searchByNickname({});
// @ts-expect-error undefined is not SQL NULL
searchByNickname({nick:undefined});
// @ts-expect-error wrong bind type
getFeed({id:"1"});
// @ts-expect-error wrong BLOB bind type
createSample({...complete,blobValue:new ArrayBuffer(1)});
// @ts-expect-error slice property is required
deleteUsersByIds({});
// @ts-expect-error slice element has the generated integer type
deleteUsersByIds({ids:["1"]});
// Empty arrays are type-expressible because the public type is ReadonlyArray<number>;
// runtime construction owns non-empty validation.
deleteUsersByIds({ids:[]});

// @ts-expect-error batch must be non-empty
db.batch();
const dynamic: QueryDescriptor<unknown>[] = [getFeed({id:1})];
// @ts-expect-error dynamic arrays are not the public tuple contract
db.batch(...dynamic);
// @ts-expect-error descriptor representation is opaque
void getFeed({id:1}).sql;
// @ts-expect-error descriptor cannot be structurally constructed
const forged: QueryDescriptor<GetFeedRow | null> = {};

// @ts-expect-error QueryExecutor cannot be directly constructed
new QueryExecutor(binding);
class ExternalExecutor extends QueryExecutor {}
// @ts-expect-error inherited protected constructor prevents external construction
new ExternalExecutor(binding);
// @ts-expect-error SessionExecutor cannot be directly constructed
new SessionExecutor();
class ExternalSession extends SessionExecutor {
  constructor() {
    // @ts-expect-error external subclasses cannot supply the private capability
    super(binding);
  }
  getBookmark(): string | null { return null; }
}

// @ts-expect-error invalid session start
 db.withSession(null);
// @ts-expect-error invalid session start
 db.withSession(1);
// @ts-expect-error command result cannot be assigned to another command shape
const wrongResult: Promise<number> = db.execute(getFeed({id:1}));
// @ts-expect-error positional batch results cannot be swapped
const wrongTuple: Promise<[ListFeedsRow[], GetFeedRow | null]> = db.batch(getFeed({id:1}), listFeeds());

void [forged, ExternalExecutor, ExternalSession, wrongResult, wrongTuple];
`;
