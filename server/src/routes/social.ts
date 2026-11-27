// User search and friends (request → accept; symmetric friendship rows).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, Ctx, limit, parse, requireUser } from "../app";
import type { PublicUser } from "./auth";

const Id = z.string().regex(/^\d{1,18}$/);

export async function areFriends(ctx: Ctx, a: string, b: string): Promise<boolean> {
  const [r] = await ctx.sql`SELECT 1 FROM friendships WHERE user_id = ${a} AND friend_id = ${b}`;
  return !!r;
}

export async function friendIds(ctx: Ctx, userId: string): Promise<string[]> {
  return (await ctx.sql<{ id: string }[]>`SELECT friend_id::text AS id FROM friendships WHERE user_id = ${userId}`).map((r) => r.id);
}

async function befriend(ctx: Ctx, a: string, b: string) {
  await ctx.sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [a, b],
    );
    await tx.unsafe(`DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`, [a, b]);
  });
}

export async function socialRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireUser(ctx) };

  /** By id ("#123" or "123") or nickname prefix. */
  app.get("/users/search", auth, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(40) }), req.query);
    await limit(ctx, `search:${req.userId}`, 60, 60);
    const idMatch = /^#?(\d{1,18})$/.exec(q);
    const esc = q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = idMatch
      ? await ctx.sql<PublicUser[]>`SELECT id::text, nickname FROM users WHERE id = ${idMatch[1]} AND id <> ${req.userId}`
      : await ctx.sql<PublicUser[]>`
          SELECT id::text, nickname FROM users
          WHERE lower(nickname) LIKE ${esc + "%"} AND id <> ${req.userId}
          ORDER BY length(nickname), id LIMIT 20`;
    const friends = new Set(await friendIds(ctx, req.userId));
    return { users: rows.map((u) => ({ ...u, friend: friends.has(u.id) })) };
  });

  app.get("/friends", auth, async (req) => {
    const me = req.userId;
    const friends = await ctx.sql<PublicUser[]>`
      SELECT u.id::text, u.nickname FROM friendships f JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ${me} ORDER BY lower(u.nickname)`;
    const incoming = await ctx.sql<{ id: string; user_id: string; nickname: string }[]>`
      SELECT r.id::text, u.id::text AS user_id, u.nickname FROM friend_requests r JOIN users u ON u.id = r.from_id
      WHERE r.to_id = ${me} ORDER BY r.created_at DESC`;
    const outgoing = await ctx.sql<{ id: string; user_id: string; nickname: string }[]>`
      SELECT r.id::text, u.id::text AS user_id, u.nickname FROM friend_requests r JOIN users u ON u.id = r.to_id
      WHERE r.from_id = ${me} ORDER BY r.created_at DESC`;
    const req2 = (r: { id: string; user_id: string; nickname: string }) => ({ id: r.id, user: { id: r.user_id, nickname: r.nickname } });
    return { friends, incoming: incoming.map(req2), outgoing: outgoing.map(req2) };
  });

  app.post("/friends/requests", auth, async (req) => {
    const { userId } = parse(z.object({ userId: Id }), req.body);
    const me = req.userId;
    if (userId === me) throw new ApiError(400, "self");
    await limit(ctx, `friendreq:${me}`, 30, 86400);
    const [target] = await ctx.sql`SELECT 1 FROM users WHERE id = ${userId}`;
    if (!target) throw new ApiError(404, "not_found");
    if (await areFriends(ctx, me, userId)) throw new ApiError(409, "already_friends");
    // they already asked me: that's a yes from both sides
    const [reverse] = await ctx.sql`SELECT 1 FROM friend_requests WHERE from_id = ${userId} AND to_id = ${me}`;
    if (reverse) {
      await befriend(ctx, me, userId);
      return { friend: true };
    }
    await ctx.sql`INSERT INTO friend_requests (from_id, to_id) VALUES (${me}, ${userId}) ON CONFLICT DO NOTHING`;
    return { friend: false };
  });

  app.post("/friends/requests/:id/accept", auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const [r] = await ctx.sql<{ from_id: string }[]>`SELECT from_id::text FROM friend_requests WHERE id = ${id} AND to_id = ${req.userId}`;
    if (!r) throw new ApiError(404, "not_found");
    await befriend(ctx, req.userId, r.from_id);
    return { ok: true };
  });

  /** Decline (incoming) or cancel (outgoing). */
  app.delete("/friends/requests/:id", auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    await ctx.sql`DELETE FROM friend_requests WHERE id = ${id} AND (to_id = ${req.userId} OR from_id = ${req.userId})`;
    return { ok: true };
  });

  app.delete("/friends/:userId", auth, async (req) => {
    const { userId } = parse(z.object({ userId: Id }), req.params);
    await ctx.sql`DELETE FROM friendships WHERE (user_id = ${req.userId} AND friend_id = ${userId}) OR (user_id = ${userId} AND friend_id = ${req.userId})`;
    return { ok: true };
  });
}
