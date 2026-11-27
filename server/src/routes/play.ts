// Practice history sync, daily challenge, leaderboards, asynchronous PK.
// Challenge scores are never taken from the client: it sends its raw tap times and
// the server judges them with the same code the app uses (src/core/challenge.ts).

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ChallengeResult,
  ChallengeSpec,
  challengeDate,
  chartDurationMs,
  dailySpec,
  judgeTaps,
  MAX_TAPS,
  noteTimes,
  specFromSeed,
} from "../../../src/core/challenge";
import { ApiError, Ctx, limit, parse, requireUser } from "../app";
import type { PublicUser } from "./auth";
import { areFriends, friendIds } from "./social";

const Id = z.string().regex(/^\d{1,18}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PK_TTL_H = 24;
const BOARD_SIZE = 50;

/** Validate taps for a chart and judge them. */
function judge(spec: ChallengeSpec, taps: unknown): ChallengeResult {
  const dur = chartDurationMs(spec);
  const list = parse(z.array(z.number().finite().min(-5000).max(dur + 5000)).max(MAX_TAPS), taps);
  return judgeTaps(noteTimes(spec), list);
}

const dailyKey = (day: string) => `lb:daily:${day}`;
const TOTAL_KEY = "lb:total";

/** Leaderboards live in Redis sorted sets; rebuilt from Postgres if Redis lost them. */
async function ensureBoard(ctx: Ctx, key: string, day: string | null) {
  if (await ctx.redis.exists(key)) return;
  const rows = day
    ? await ctx.sql<{ id: string; score: number }[]>`SELECT user_id::text AS id, score FROM daily_scores WHERE day = ${day}`
    : await ctx.sql<{ id: string; score: number }[]>`SELECT user_id::text AS id, sum(score)::int AS score FROM daily_scores GROUP BY user_id`;
  if (!rows.length) return;
  const args: (string | number)[] = [];
  for (const r of rows) args.push(r.score, r.id);
  await ctx.redis.zadd(key, ...args);
}

async function nicknames(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await ctx.sql<PublicUser[]>`SELECT id::text, nickname FROM users WHERE id IN ${ctx.sql(ids)}`;
  return new Map(rows.map((r) => [r.id, r.nickname]));
}

interface PkRow {
  id: string;
  challenger_id: string;
  opponent_id: string;
  spec: ChallengeSpec;
  status: "open" | "declined" | "done";
  created_at: Date;
  expires_at: Date;
  challenger_result: ChallengeResult | null;
  opponent_result: ChallengeResult | null;
}

/** A match as one player sees it. The other side's result shows once I've played or the match is over. */
function pkView(m: PkRow, me: string, names: Map<string, string>) {
  const iAmChallenger = m.challenger_id === me;
  const mine = iAmChallenger ? m.challenger_result : m.opponent_result;
  const theirs = iAmChallenger ? m.opponent_result : m.challenger_result;
  const expired = m.status === "open" && m.expires_at.getTime() < Date.now();
  const status = expired ? "expired" : m.status;
  const over = status !== "open";
  let winner: "me" | "them" | "draw" | null = null;
  if (status === "done" && mine && theirs) winner = mine.score > theirs.score ? "me" : mine.score < theirs.score ? "them" : "draw";
  else if (status === "expired") winner = mine && !theirs ? "me" : theirs && !mine ? "them" : null;
  const other = iAmChallenger ? m.opponent_id : m.challenger_id;
  return {
    id: m.id,
    spec: m.spec,
    role: iAmChallenger ? "challenger" : "opponent",
    opponent: { id: other, nickname: names.get(other) ?? "?" },
    createdAt: m.created_at.toISOString(),
    expiresAt: m.expires_at.toISOString(),
    status,
    mine,
    theirs: mine || over ? theirs : null,
    theyPlayed: !!theirs,
    winner,
  };
}

export async function playRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireUser(ctx) };
  const today = () => challengeDate(Date.now(), ctx.cfg.dailyTzOffsetMin);

  // ---------------------------------------------------------------- history sync
  app.post("/sessions", auth, async (req) => {
    const { sessions } = parse(
      z.object({ sessions: z.array(z.looseObject({ startedAt: z.number().int().positive() })).max(50) }),
      req.body,
    );
    let stored = 0;
    for (const s of sessions) {
      if (JSON.stringify(s).length > 400_000) continue; // oversized detail: skip
      const r = await ctx.sql`
        INSERT INTO practice_sessions (user_id, started_at, data) VALUES (${req.userId}, ${s.startedAt}, ${ctx.sql.json(s as never)})
        ON CONFLICT DO NOTHING`;
      stored += r.count;
    }
    return { stored };
  });

  app.get("/sessions", auth, async (req) => {
    const rows = await ctx.sql<{ data: unknown }[]>`
      SELECT data FROM practice_sessions WHERE user_id = ${req.userId} ORDER BY started_at DESC LIMIT 200`;
    return { sessions: rows.map((r) => r.data) };
  });

  // ---------------------------------------------------------------- daily challenge
  app.get("/daily", auth, async (req) => {
    const day = today();
    const [best] = await ctx.sql<{ result: ChallengeResult; attempts: number }[]>`
      SELECT result, attempts FROM daily_scores WHERE user_id = ${req.userId} AND day = ${day}`;
    return { date: day, spec: dailySpec(day), best: best?.result ?? null, attempts: best?.attempts ?? 0 };
  });

  app.post("/daily/submit", auth, async (req) => {
    const b = parse(z.object({ date: Day, taps: z.unknown() }), req.body);
    // a run that started just before the daily rollover still counts for its day
    const graceDay = challengeDate(Date.now() - 10 * 60000, ctx.cfg.dailyTzOffsetMin);
    if (b.date !== today() && b.date !== graceDay) throw new ApiError(400, "expired");
    await limit(ctx, `daily:${req.userId}:${b.date}`, 100, 86400);
    const result = judge(dailySpec(b.date), b.taps);
    const [prev] = await ctx.sql<{ score: number }[]>`SELECT score FROM daily_scores WHERE user_id = ${req.userId} AND day = ${b.date}`;
    const json = ctx.sql.json(result as never);
    await ctx.sql`
      INSERT INTO daily_scores (user_id, day, score, result) VALUES (${req.userId}, ${b.date}, ${result.score}, ${json})
      ON CONFLICT (user_id, day) DO UPDATE SET
        attempts = daily_scores.attempts + 1,
        score  = GREATEST(daily_scores.score, EXCLUDED.score),
        result = CASE WHEN EXCLUDED.score > daily_scores.score THEN EXCLUDED.result ELSE daily_scores.result END,
        best_at = CASE WHEN EXCLUDED.score > daily_scores.score THEN now() ELSE daily_scores.best_at END`;
    const improved = !prev || result.score > prev.score;
    if (improved) {
      await ensureBoard(ctx, dailyKey(b.date), b.date);
      await ensureBoard(ctx, TOTAL_KEY, null);
      await ctx.redis.zadd(dailyKey(b.date), "GT", result.score, req.userId);
      await ctx.redis.expire(dailyKey(b.date), 40 * 86400);
      await ctx.redis.zincrby(TOTAL_KEY, result.score - (prev?.score ?? 0), req.userId);
    }
    const rank = await ctx.redis.zrevrank(dailyKey(b.date), req.userId);
    return { result, best: improved ? result.score : prev.score, improved, rank: rank === null ? null : rank + 1 };
  });

  // ---------------------------------------------------------------- leaderboards
  app.get("/leaderboard", auth, async (req) => {
    const q = parse(
      z.object({ board: z.enum(["daily", "total"]).default("daily"), scope: z.enum(["global", "friends"]).default("global"), date: Day.optional() }),
      req.query,
    );
    const day = q.date ?? today();
    const key = q.board === "daily" ? dailyKey(day) : TOTAL_KEY;
    await ensureBoard(ctx, key, q.board === "daily" ? day : null);
    let entries: { id: string; score: number }[];
    if (q.scope === "global") {
      const raw = await ctx.redis.zrevrange(key, 0, BOARD_SIZE - 1, "WITHSCORES");
      entries = [];
      for (let i = 0; i < raw.length; i += 2) entries.push({ id: raw[i], score: Number(raw[i + 1]) });
    } else {
      const ids = [req.userId, ...(await friendIds(ctx, req.userId))];
      const scores = await ctx.redis.zmscore(key, ...ids);
      entries = ids.map((id, i) => ({ id, score: scores[i] === null ? NaN : Number(scores[i]) })).filter((e) => !Number.isNaN(e.score));
      entries.sort((a, b) => b.score - a.score);
    }
    const names = await nicknames(ctx, [...entries.map((e) => e.id), req.userId]);
    const myRank = await ctx.redis.zrevrank(key, req.userId);
    const myScore = await ctx.redis.zscore(key, req.userId);
    return {
      board: q.board,
      scope: q.scope,
      date: q.board === "daily" ? day : null,
      entries: entries.map((e, i) => ({ rank: i + 1, user: { id: e.id, nickname: names.get(e.id) ?? "?" }, score: e.score, me: e.id === req.userId })),
      me: myScore === null ? null : { rank: (myRank ?? 0) + 1, score: Number(myScore) },
    };
  });

  // ---------------------------------------------------------------- PK
  const loadPk = async (id: string, me: string) => {
    const [m] = await ctx.sql<PkRow[]>`
      SELECT id::text, challenger_id::text, opponent_id::text, spec, status, created_at, expires_at, challenger_result, opponent_result
      FROM pk_matches WHERE id = ${id} AND (challenger_id = ${me} OR opponent_id = ${me})`;
    if (!m) throw new ApiError(404, "not_found");
    return m;
  };
  const view = async (m: PkRow, me: string) => pkView(m, me, await nicknames(ctx, [m.challenger_id, m.opponent_id]));

  app.post("/pk", auth, async (req) => {
    const { opponentId } = parse(z.object({ opponentId: Id }), req.body);
    if (opponentId === req.userId) throw new ApiError(400, "self");
    if (!(await areFriends(ctx, req.userId, opponentId))) throw new ApiError(403, "not_friends");
    await limit(ctx, `pk:${req.userId}`, 30, 86400);
    const spec = specFromSeed(`pk:${crypto.randomUUID()}`);
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO pk_matches (challenger_id, opponent_id, spec, expires_at)
      VALUES (${req.userId}, ${opponentId}, ${ctx.sql.json(spec as never)}, now() + make_interval(hours => ${PK_TTL_H}))
      RETURNING id::text`;
    return view(await loadPk(row.id, req.userId), req.userId);
  });

  app.get("/pk", auth, async (req) => {
    const me = req.userId;
    const rows = await ctx.sql<PkRow[]>`
      SELECT id::text, challenger_id::text, opponent_id::text, spec, status, created_at, expires_at, challenger_result, opponent_result
      FROM pk_matches WHERE (challenger_id = ${me} OR opponent_id = ${me}) AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 50`;
    const names = await nicknames(ctx, [...new Set(rows.flatMap((r) => [r.challenger_id, r.opponent_id]))]);
    return { matches: rows.map((r) => pkView(r, me, names)) };
  });

  app.get("/pk/:id", auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    return view(await loadPk(id, req.userId), req.userId);
  });

  app.post("/pk/:id/submit", auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const { taps } = parse(z.object({ taps: z.unknown() }), req.body);
    const me = req.userId;
    const m = await loadPk(id, me);
    if (m.status !== "open") throw new ApiError(409, "closed");
    if (m.expires_at.getTime() < Date.now()) throw new ApiError(409, "expired");
    const col = m.challenger_id === me ? "challenger_result" : "opponent_result";
    if (m[col]) throw new ApiError(409, "already_played");
    const result = judge(m.spec, taps);
    const json = ctx.sql.json(result as never);
    // set my result only if still empty; close the match once both have played
    const updated =
      col === "challenger_result"
        ? await ctx.sql`UPDATE pk_matches SET challenger_result = ${json},
            status = CASE WHEN opponent_result IS NOT NULL THEN 'done' ELSE status END
            WHERE id = ${id} AND challenger_result IS NULL AND status = 'open'`
        : await ctx.sql`UPDATE pk_matches SET opponent_result = ${json},
            status = CASE WHEN challenger_result IS NOT NULL THEN 'done' ELSE status END
            WHERE id = ${id} AND opponent_result IS NULL AND status = 'open'`;
    if (!updated.count) throw new ApiError(409, "already_played");
    return view(await loadPk(id, me), me);
  });

  app.post("/pk/:id/decline", auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const r = await ctx.sql`
      UPDATE pk_matches SET status = 'declined'
      WHERE id = ${id} AND opponent_id = ${req.userId} AND status = 'open' AND opponent_result IS NULL`;
    if (!r.count) throw new ApiError(409, "closed");
    return view(await loadPk(id, req.userId), req.userId);
  });
}
