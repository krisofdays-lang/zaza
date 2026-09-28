"use client"

import { useEffect, useState, useCallback } from "react"
import { ListChecks, Loader2, CheckCircle2, XCircle, Ban, Clock, X, Trash2, Eraser } from "lucide-react"
import { toast } from "sonner"
import { getWarmupJobs, cancelWarmup, dismissWarmupJob, clearWarmupJobs } from "@/app/actions/warmup"
import type { WarmupJobStatus } from "@/lib/warmup/types"

const KIND_LABEL: Record<string, string> = {
  feed_scroll: "Feed Scroll",
  reels_scroll: "Reels Scroll",
  feed_training: "Feed Training",
  stories_tracker: "Stories Tracker",
}

function StatusBadge({ status }: { status: WarmupJobStatus["status"] }) {
  const map = {
    running: { icon: Loader2, cls: "text-[#fa7e1e]", spin: true, label: "running" },
    queued: { icon: Clock, cls: "text-muted-foreground", spin: false, label: "queued" },
    done: { icon: CheckCircle2, cls: "text-emerald-400", spin: false, label: "done" },
    error: { icon: XCircle, cls: "text-destructive", spin: false, label: "error" },
    cancelled: { icon: Ban, cls: "text-muted-foreground", spin: false, label: "cancelled" },
  }[status]
  const Icon = map.icon
  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${map.cls}`}>
      <Icon className={`size-3.5 ${map.spin ? "animate-spin" : ""}`} />
      {map.label}
    </span>
  )
}

export function WarmupQueue({ initial, refreshSignal = 0 }: { initial: WarmupJobStatus[]; refreshSignal?: number }) {
  const [jobs, setJobs] = useState<WarmupJobStatus[]>(initial)

  const refresh = useCallback(async () => {
    try {
      setJobs(await getWarmupJobs(20))
    } catch {
      // ignore transient poll errors
    }
  }, [])

  // Refresh immediately when the parent signals a new session was started.
  useEffect(() => {
    if (refreshSignal > 0) refresh()
  }, [refreshSignal, refresh])

  // Poll while any job is active.
  useEffect(() => {
    const active = jobs.some((j) => j.status === "running" || j.status === "queued")
    const interval = setInterval(refresh, active ? 3000 : 12000)
    return () => clearInterval(interval)
  }, [jobs, refresh])

  async function handleCancel(id: number) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, phase: "cancelling" } : j)))
    await cancelWarmup(id)
    toast.message("Cancelling session…")
    refresh()
  }

  async function handleDismiss(id: number) {
    // Optimistically drop it from the list, then confirm on the server.
    const prev = jobs
    setJobs((cur) => cur.filter((j) => j.id !== id))
    const res = await dismissWarmupJob(id)
    if (!res.ok) {
      setJobs(prev)
      toast.error(res.error ?? "Could not remove session")
    }
  }

  async function handleClear() {
    const prev = jobs
    setJobs((cur) => cur.filter((j) => j.status === "running" || j.status === "queued"))
    const res = await clearWarmupJobs()
    if (res.ok) toast.success(`Cleared ${res.cleared} session${res.cleared === 1 ? "" : "s"}`)
    else setJobs(prev)
    refresh()
  }

  const finishedCount = jobs.filter(
    (j) => j.status === "done" || j.status === "error" || j.status === "cancelled",
  ).length

  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="ig-gradient-text">
          <ListChecks className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">Queue</h2>
        <span className="text-xs text-muted-foreground">({jobs.length})</span>
        {finishedCount > 0 && (
          <button
            onClick={handleClear}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Eraser className="size-3" /> Clear finished
          </button>
        )}
      </header>
      <div className="max-h-[28rem] overflow-y-auto p-2">
        {jobs.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            No warm-up sessions yet. Start one to see it here.
          </p>
        ) : (
          <ul className="space-y-1">
            {jobs.map((j) => {
              const active = j.status === "running" || j.status === "queued"
              const pct = j.total > 0 ? Math.round((j.processed / j.total) * 100) : 0
              return (
                <li key={j.id} className="rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary/50">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{KIND_LABEL[j.kind] ?? j.kind}</span>
                      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                        {j.total} acct{j.total === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={j.status} />
                      {active ? (
                        <button
                          onClick={() => handleCancel(j.id)}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <X className="size-3" /> Cancel
                        </button>
                      ) : (
                        <button
                          onClick={() => handleDismiss(j.id)}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Remove session"
                        >
                          <Trash2 className="size-3" /> Remove
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {j.currentLabel ? `@${j.currentLabel} — ${j.phase}` : j.phase || "—"}
                    </span>
                    <span className="shrink-0 tabular-nums">{j.actionsCount} actions</span>
                  </div>
                  {/* Progress bar shown for every job; color reflects status. */}
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={`h-full transition-all ${
                          j.status === "error"
                            ? "bg-destructive"
                            : j.status === "cancelled"
                              ? "bg-muted-foreground"
                              : j.status === "done"
                                ? "bg-emerald-500"
                                : "ig-gradient"
                        }`}
                        style={{ width: `${j.status === "done" ? 100 : pct}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {j.processed}/{j.total}
                    </span>
                  </div>
                  {j.status === "error" && j.error && (
                    <p className="mt-1 truncate text-xs text-destructive">{j.error}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
