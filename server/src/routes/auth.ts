// Email sign-up with a verification code, password login, password reset.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword, newCode, newRefreshToken, REFRESH_TTL_DAYS, tokenHash, verifyPassword } from "../auth";
import { ApiError, Ctx, limit, parse, requireUser } from "../app";
import { codeMail, CodePurpose } from "../mail";

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const Password = z.string().min(8).max(128);
const Nickname = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .refine((s) => !/[\u0000-\u001f]/.test(s));
const Code = z.string().regex(/^\d{6}$/);

const CODE_TTL_S = 600;
const CODE_TRIES = 5;

export interface PublicUser {
  id: string;
  nickname: string;
}

export async function userById(ctx: Ctx, id: string): Promise<PublicUser & { email: string }> {
  const [u] = await ctx.sql<{ id: string; nickname: string; email: string }[]>`SELECT id::text, nickname, email FROM users WHERE id = ${id}`;
  if (!u) throw new ApiError(401, "unauthorized");
  return u;
}

async function issueLogin(ctx: Ctx, userId: string) {
  const refreshToken = newRefreshToken();
  await ctx.sql`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash(refreshToken)}, now() + make_interval(days => ${REFRESH_TTL_DAYS}))`;
  return { accessToken: await ctx.tokens.sign(userId), refreshToken, user: await userById(ctx, userId) };
}

/** Check a mailed code; each code allows a few tries, then it is burnt. */
async function useCode(ctx: Ctx, purpose: CodePurpose, email: string, code: string) {
  const key = `code:${purpose}:${email}`;
  const raw = await ctx.redis.get(key);
  if (!raw) throw new ApiError(400, "bad_code");
  const entry = JSON.parse(raw) as { code: string; tries: number };
  if (entry.code !== code) {
    entry.tries++;
    if (entry.tries >= CODE_TRIES) await ctx.redis.del(key);
    else await ctx.redis.set(key, JSON.stringify(entry), "KEEPTTL");
    throw new ApiError(400, "bad_code");
  }
  await ctx.redis.del(key);
}

export async function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = requireUser(ctx);

  app.post("/auth/code", async (req) => {
    const { email, purpose } = parse(z.object({ email: Email, purpose: z.enum(["register", "reset"]) }), req.body);
    await limit(ctx, `code-ip:${req.ip}`, 20, 3600);
    const [exists] = await ctx.sql`SELECT 1 FROM users WHERE lower(email) = ${email}`;
    if (purpose === "register" && exists) throw new ApiError(409, "email_taken");
    // reset: answer the same whether or not the account exists
    if (purpose === "reset" && !exists) return { sent: true };
    await limit(ctx, `code-mail:${email}`, 1, 60);
    await limit(ctx, `code-mail-day:${email}`, 10, 86400);
    const code = newCode();
    await ctx.redis.set(`code:${purpose}:${email}`, JSON.stringify({ code, tries: 0 }), "EX", CODE_TTL_S);
    const m = codeMail(purpose, code);
    await ctx.mailer.send(email, m.subject, m.text);
    return { sent: true };
  });

  app.post("/auth/register", async (req) => {
    const b = parse(z.object({ email: Email, code: Code, password: Password, nickname: Nickname }), req.body);
    await useCode(ctx, "register", b.email, b.code);
    const hash = await hashPassword(b.password);
    const rows = await ctx.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, nickname) VALUES (${b.email}, ${hash}, ${b.nickname})
      ON CONFLICT DO NOTHING RETURNING id::text`;
    if (!rows.length) throw new ApiError(409, "email_taken");
    return issueLogin(ctx, rows[0].id);
  });

  app.post("/auth/login", async (req) => {
    const b = parse(z.object({ email: Email, password: z.string().max(128) }), req.body);
    await limit(ctx, `login:${b.email}`, 10, 900);
    const [u] = await ctx.sql<{ id: string; password_hash: string }[]>`SELECT id::text, password_hash FROM users WHERE lower(email) = ${b.email}`;
    if (!u || !(await verifyPassword(b.password, u.password_hash))) throw new ApiError(401, "bad_login");
    return issueLogin(ctx, u.id);
  });

  app.post("/auth/refresh", async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    const [t] = await ctx.sql<{ user_id: string }[]>`
      SELECT user_id::text FROM refresh_tokens
      WHERE token_hash = ${tokenHash(refreshToken)} AND revoked_at IS NULL AND expires_at > now()`;
    if (!t) throw new ApiError(401, "unauthorized");
    return { accessToken: await ctx.tokens.sign(t.user_id), user: await userById(ctx, t.user_id) };
  });

  app.post("/auth/logout", async (req) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().max(200) }), req.body);
    await ctx.sql`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = ${tokenHash(refreshToken)} AND revoked_at IS NULL`;
    return { ok: true };
  });

  app.post("/auth/reset", async (req) => {
    const b = parse(z.object({ email: Email, code: Code, password: Password }), req.body);
    await useCode(ctx, "reset", b.email, b.code);
    const hash = await hashPassword(b.password);
    const [u] = await ctx.sql<{ id: string }[]>`UPDATE users SET password_hash = ${hash} WHERE lower(email) = ${b.email} RETURNING id::text`;
    if (!u) throw new ApiError(400, "bad_code");
    // signed out everywhere else
    await ctx.sql`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${u.id} AND revoked_at IS NULL`;
    return issueLogin(ctx, u.id);
  });

  app.get("/me", { preHandler: auth }, async (req) => userById(ctx, req.userId));

  app.patch("/me", { preHandler: auth }, async (req) => {
    const { nickname } = parse(z.object({ nickname: Nickname }), req.body);
    await ctx.sql`UPDATE users SET nickname = ${nickname} WHERE id = ${req.userId}`;
    return userById(ctx, req.userId);
  });
}
