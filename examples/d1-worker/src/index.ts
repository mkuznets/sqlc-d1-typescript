import { DB, SqlcD1Error } from "./runtime";
import { getUser, listUsers, renameUser } from "./queries_sql";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const parseId = (value: string): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/users") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return json({ users: await new DB(env.DB).execute(listUsers()) });
      }

      const match = /^\/users\/([^/]+)$/.exec(url.pathname);
      if (!match) return json({ error: "not_found" }, 404);
      if (request.method !== "GET" && request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
      const id = parseId(match[1]);
      if (id === null) return json({ error: "invalid_request" }, 400);
      const db = new DB(env.DB);
      if (request.method === "GET") {
        const [user, users] = await db.batch(getUser({ id }), listUsers());
        return json({ user, users });
      }

      const body = await request.json().catch(() => null);
      if (!isRenameBody(body)) return json({ error: "invalid_request" }, 400);
      const session = db.withSession("first-primary");
      const user = await session.execute(renameUser({ name: body.name, id }));
      return json({ user, bookmarkAvailable: session.getBookmark() !== null });
    } catch (error) {
      if (error instanceof SqlcD1Error) return json({ error: "query_failed", kind: error.name }, 500);
      return json({ error: "internal_error" }, 500);
    }
  },
};

function isRenameBody(value: unknown): value is { name: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.name === "string" && record.name.trim().length > 0;
}
