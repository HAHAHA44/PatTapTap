import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** Apply migrations/*.sql in name order, each once, inside a transaction. */
export async function migrate(sql: Sql, dir: string) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  // only one server instance runs migrations at a time
  await sql`SELECT pg_advisory_lock(727274)`;
  try {
    const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx.unsafe("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      });
      console.log(`migration applied: ${f}`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(727274)`;
  }
}
