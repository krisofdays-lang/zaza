"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ScrollText, X, ChevronDown, Loader2, Check, TriangleAlert, RefreshCw, Clock } from "lucide-react"
import type { RunLogEntry, RunState } from "@/components/workflows/use-workflow-run"

const LEVEL_META: Record<RunLogEntry["level"], { icon: typeof Check; cls: string }> = {
  info: { icon: Loader2, cls: "text-sky-400" },
  ok: { icon: Check, cls: "text-emerald-400" },
  error: { icon: TriangleAlert, cls: "text-destructive" },
  wait: { icon: Clock, cls: "text-amber-400" },
  rotate: { icon: RefreshCw, cls: "text-[#c13584]" },
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

// Outcome buckets for the end-of-run summary.
interface RunSummary {
  ok: string[] // completed at least one action with no errors
  partial: string[] // ran but hit one or more errors
  failed: string[] // produced only errors / never succeeded
  idle: string[] // selected but never appeared in the logs at all
}

// Derive a per-account outcome from the current run's log lines (everything
// after the last divider). `expected` is the set of accounts this run targeted.
function summarize(logs: RunLogEntry[], expected: string[]): RunSummary {
  // Only look at the most recent run segment.
  let start = 0
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].divider) {
      start = i + 1
      break
    }
  }
  const segment = logs.slice(start).filter((l) => !l.divider && l.account)

  const seen = new Map<string, { ok: number; err: number }>()
  for (const l of segment) {
    const cur = seen.get(l.account) ?? { ok: 0, err: 0 }
    if (l.level === "error") cur.err++
    else if (l.level === "ok") cur.ok++
    seen.set(l.account, cur)
  }

  const ok: string[] = []
  const partial: string[] = []
  const failed: string[] = []
  for (const [account, { ok: okN, err }] of seen) {
    if (err === 0 && okN > 0) ok.push(account)
    else if (okN > 0 && err > 0) partial.push(account)
    else if (err > 0) failed.push(account)
    else ok.push(account) // saw activity but no terminal markers — treat as ran
  }
  const idle = expected.filter((a) => !seen.has(a))
  return { ok, partial, failed, idle }
}

function SummaryRow({ label, items, cls }: { label: string; items: string[]; cls: string }) {
  if (items.length === 0) return null
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className={`shrink-0 font-semibold ${cls}`}>
        {label} ({items.length})
      </span>
      <span className="min-w-0 break-words text-muted-foreground">{items.join(", ")}</span>
    </div>
  )
}

/**
 * Floating Live Logs panel for a workflow run. Shows, per line, which account is
 * doing which action and the result. Logs are preserved across runs (separated
 * by dividers), the list is scrollable, and a summary of outcomes is shown once
 * the run finishes. Collapsible to a pill via `onToggle`.
 */
export function LiveLogs({
  state,
  open,
  onToggle,
  accounts = [],
}: {
  state: RunState
  open: boolean
  onToggle: (open: boolean) => void
  // Display handles of the accounts targeted by the run (for the "didn't run" bucket).
  accounts?: string[]
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Track whether the user is pinned to the bottom so manual scroll-up isn't
  // yanked back down by streaming lines.
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    if (open && atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [state.logs, open, atBottom])

  const running = state.status === "running"
  const finished = state.status === "done" || state.status === "error" || state.status === "cancelled"
  const summary = useMemo(
    () => (finished ? summarize(state.logs, accounts) : null),
    [finished, state.logs, accounts],
  )

  if (!open) {
    return (
      <button
        onClick={() => onToggle(true)}
        className="absolute bottom-4 right-4 z-10 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md hover:text-foreground"
      >
        <ScrollText className="size-3.5" /> Live Logs
        {running && <Loader2 className="size-3 animate-spin text-[#fa7e1e]" />}
        {state.logs.length > 0 && (
          <span className="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums">
            {state.logs.filter((l) => !l.divider).length}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="absolute bottom-4 right-4 z-20 flex h-96 w-96 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <ScrollText className="size-4 text-[#fa7e1e]" /> Live Logs
        </span>
        {running ? (
          <span className="flex items-center gap-1 text-xs text-[#fa7e1e]">
            <Loader2 className="size-3 animate-spin" /> running
          </span>
        ) : (
          <span className="text-xs capitalize text-muted-foreground">{state.status}</span>
        )}
        <button
          onClick={() => onToggle(false)}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Collapse live logs"
        >
          <ChevronDown className="size-4" />
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {state.logs.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">No activity yet. Run the workflow to stream logs.</p>
        ) : (
          <ul className="space-y-1">
            {state.logs.map((entry) => {
              if (entry.divider) {
                return (
                  <li key={entry.id} className="flex items-center gap-2 py-1 text-[10px] text-muted-foreground/60">
                    <span className="h-px flex-1 bg-border" />
                    <span className="uppercase tracking-wider">{entry.message}</span>
                    <span className="h-px flex-1 bg-border" />
                  </li>
                )
              }
              const meta = LEVEL_META[entry.level]
              const Icon = meta.icon
              return (
                <li key={entry.id} className="flex items-start gap-2">
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">{fmtTime(entry.ts)}</span>
                  <Icon
                    className={`mt-0.5 size-3 shrink-0 ${meta.cls} ${entry.level === "info" ? "animate-spin" : ""}`}
                  />
                  <span className="min-w-0">
                    <span className="font-semibold text-foreground">{entry.account}</span>
                    <span className="text-muted-foreground"> · {entry.action} — </span>
                    <span className={meta.cls}>{entry.message}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {summary && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-t border-border bg-secondary/30 px-3 py-2 font-mono text-[11px]">
          <p className="mb-1 font-semibold text-foreground">Run summary</p>
          <SummaryRow label="Done" items={summary.ok} cls="text-emerald-400" />
          <SummaryRow label="Partial" items={summary.partial} cls="text-amber-400" />
          <SummaryRow label="Failed" items={summary.failed} cls="text-destructive" />
          <SummaryRow label="Didn't run" items={summary.idle} cls="text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

// Re-export for callers that close the panel via an X elsewhere.
export const LiveLogsCloseIcon = X
