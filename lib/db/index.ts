import { drizzle } from "drizzle-orm/node-postgres"
import { Pool, type PoolConfig } from "pg"
import * as schema from "./schema"

// The app talks to a standard PostgreSQL server through node-postgres. It works
// with any Postgres (managed or self-hosted) — only the connection string and
// SSL mode change between providers.
//
// SSL handling:
//   - Managed providers (e.g. Neon) require TLS; their URLs usually carry
//     `sslmode=require`, which node-postgres honours automatically.
//   - A self-hosted/external Postgres may use a self-signed certificate. Set
//     `DATABASE_SSL` to control this explicitly:
//       • "require" / "true"        -> TLS, but don't reject self-signed certs
//       • "no-verify"               -> TLS, skip verification (self-signed)
//       • "false" / "disable"       -> plaintext (no TLS)
//       • unset                     -> infer from the connection string
function resolveSsl(): PoolConfig["ssl"] {
  const mode = (process.env.DATABASE_SSL || "").trim().toLowerCase()
  if (mode === "false" || mode === "disable" || mode === "off") return false
  if (mode === "require" || mode === "true" || mode === "on" || mode === "no-verify") {
    return { rejectUnauthorized: false }
  }
  // No explicit flag: if the URL already asks for SSL, relax cert verification
  // so self-signed external servers connect; otherwise leave it to the driver.
  const url = process.env.DATABASE_URL || ""
  if (/sslmode=(require|verify|prefer)/i.test(url)) return { rejectUnauthorized: false }
  return undefined
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(),
})
export const db = drizzle(pool, { schema })
