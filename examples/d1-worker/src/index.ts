import { Hono } from "hono";

import { DB, SqlcD1Error } from "./runtime";
import { getUser, listUsers, renameUser } from "./queries_sql";

const app = new Hono<{ Bindings: Env }>();

app.get("/users", async (c) => {
  const users = await new DB(c.env.DB).execute(listUsers());

  return c.json({ users });
});

app.get("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));

  const [user, users] = await new DB(c.env.DB).batch(getUser({ id }), listUsers());

  return c.json({ user, users });
});

app.patch("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json<{ name: string }>();

  const session = new DB(c.env.DB).withSession("first-primary");
  const user = await session.execute(renameUser({ name, id }));

  return c.json({ user, bookmarkAvailable: session.getBookmark() !== null });
});

// The generated argument checks reject a malformed id or name before it reaches D1.
app.onError((error, c) => c.json({ error: error instanceof SqlcD1Error ? "query_failed" : "internal_error" }, 500));

export default app;
