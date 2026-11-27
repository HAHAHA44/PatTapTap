import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { Tokens } from "./auth";
import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { smtpMailer } from "./mail";

const here = path.dirname(fileURLToPath(import.meta.url));
// migrations sit next to the source (dev) or next to the bundle (Docker image)
const migrations = process.env.MIGRATIONS_DIR ?? path.resolve(here, "../migrations");

const cfg = loadConfig();
const sql = connect(cfg.databaseUrl);
const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 3 });
await migrate(sql, migrations);
const app = await buildApp({ cfg, sql, redis, mailer: smtpMailer(cfg.smtpUrl, cfg.mailFrom), tokens: new Tokens(cfg.jwtSecret) });

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
