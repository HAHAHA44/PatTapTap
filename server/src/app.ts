import cors from "@fastify/cors";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z, ZodError } from "zod";
import { Tokens } from "./auth";
import type { Config } from "./config";
import type { Sql } from "./db";
import type { Mailer } from "./mail";
import { authRoutes } from "./routes/auth";
import { playRoutes } from "./routes/play";
import { socialRoutes } from "./routes/social";

export interface Ctx {
  cfg: Config;
  sql: Sql;
  redis: Redis;
  mailer: Mailer;
  tokens: Tokens;
}

/** An error the client can act on: HTTP status + a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

/** Parse and validate input; failures become 400 bad_request. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

/** Fixed-window rate limit in Redis. Throws 429 too_many when exceeded. */
export async function limit(ctx: Ctx, key: string, max: number, windowS: number) {
  const k = `rl:${key}`;
  const n = await ctx.redis.incr(k);
  if (n === 1) await ctx.redis.expire(k, windowS);
  if (n > max) throw new ApiError(429, "too_many");
}

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/** preHandler: requires "Authorization: Bearer <access token>". */
export function requireUser(ctx: Ctx) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const id = token ? await ctx.tokens.verify(token) : null;
    if (!id) throw new ApiError(401, "unauthorized");
    req.userId = id;
  };
}

export async function buildApp(ctx: Ctx) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 4 * 1024 * 1024, trustProxy: true });
  await app.register(cors, { origin: ctx.cfg.corsOrigins, methods: ["GET", "POST", "PATCH", "DELETE"] });

  app.setErrorHandler((err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.code });
    if (err instanceof ZodError) return reply.status(400).send({ error: "bad_request", issues: err.issues.slice(0, 5) });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "bad_request" });
    app.log.error(err);
    return reply.status(500).send({ error: "server_error" });
  });

  app.get("/health", async () => {
    await ctx.sql`SELECT 1`;
    await ctx.redis.ping();
    return { ok: true };
  });

  await authRoutes(app, ctx);
  await socialRoutes(app, ctx);
  await playRoutes(app, ctx);
  return app;
}
