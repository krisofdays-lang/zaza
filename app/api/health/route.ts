import { NextResponse } from "next/server"
import { pool } from "@/lib/db"

// Readiness probe used by Docker's healthcheck and Caddy's load balancer.
// A replica is only routed traffic once this returns 200, and it is pulled out
// of rotation during shutdown — which is what keeps rolling updates seamless.
// It runs a quick `SELECT 1` so a replica that can't reach the database is
// reported unhealthy rather than silently serving errors.
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    await pool.query("SELECT 1")
    return NextResponse.json({ status: "ok" }, { status: 200 })
  } catch {
    return NextResponse.json({ status: "db_unavailable" }, { status: 503 })
  }
}
