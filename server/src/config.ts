// All settings come from the environment (see deploy/.env.example).

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name}`);
  return v;
}

export interface Config {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** HMAC secret for access tokens (>= 32 chars). */
  jwtSecret: string;
  /** SMTP connection URL, e.g. smtp://mailpit:1025 or smtps://user:pass@smtp.example.com:465 */
  smtpUrl: string;
  mailFrom: string;
  /** Allowed browser origins (the desktop app's webviews). */
  corsOrigins: string[];
  /** UTC offset (minutes) that decides when the daily challenge rolls over. */
  dailyTzOffsetMin: number;
}

export function loadConfig(): Config {
  const jwtSecret = env("JWT_SECRET");
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  return {
    port: Number(env("PORT", "8080")),
    databaseUrl: env("DATABASE_URL"),
    redisUrl: env("REDIS_URL"),
    jwtSecret,
    smtpUrl: env("SMTP_URL"),
    mailFrom: env("MAIL_FROM", "PatPatTap <no-reply@patpattap.local>"),
    corsOrigins: env("CORS_ORIGINS", "tauri://localhost,http://tauri.localhost,http://localhost:1420")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dailyTzOffsetMin: Number(env("DAILY_TZ_OFFSET_MIN", "480")),
  };
}
