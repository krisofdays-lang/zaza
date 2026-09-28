import fs from "node:fs"
import path from "node:path"

// Simple append-only file logger for debugging server action failures that
// don't show up in the request log panel (e.g. DB writes, revalidatePath).
// Never throws — logging must not be able to crash the caller.
const LOG_FILE = path.join(process.cwd(), "debug.log")

function serialize(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}`
  }
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function logToFile(label: string, ...details: unknown[]) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    const timestamp = new Date().toISOString()
    const body = details.map(serialize).join(" ")
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${label} ${body}\n`)
  } catch {
    // Swallow — file logging is best-effort only.
  }
}
