"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Eye, Heart, TrendingUp, Film, RefreshCw, Users, ChevronDown, Clapperboard, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { startAnalyticsRefresh, getAnalyticsJob, getLatestSnapshot } from "@/app/actions/analytics"
import type { AnalyticsResult, AnalyticsJobStatus } from "@/lib/analytics/types"
import { TopAccounts } from "./top-accounts"
import { ReelCard, formatCompact } from "./reel-card"
import { cn } from "@/lib/utils"

type AccountLite = { id: number; username: string; label: string }

const POLL_MS = 5000

export function AnalyticsView({
  initial,
  hasSnapshot,
  generatedAt,
  stale,
  initialJob,
  accounts,
}: {
  initial: AnalyticsResult
  hasSnapshot: boolean
  generatedAt: string | null
  stale: boolean
  initialJob: AnalyticsJobStatus | null
  accounts: AccountLite[]
}) {
  const [data, setData] = useState<AnalyticsResult>(initial)
  const [snapshotAt, setSnapshotAt] = useState<string | null>(generatedAt)
  const [isStale, setIsStale] = useState(stale)
  const [hasData, setHasData] = useState(hasSnapshot)
  const [selected, setSelected] = useState<number[]>([])
  const [job, setJob] = useState<AnalyticsJobStatus | null>(initialJob)
  // Date formatting depends on the runtime locale, which differs between the
  // server and the browser. Defer it to the client to avoid hydration mismatch.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const running = job?.status === "running"
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reloadSnapshot = useCallback(async () => {
    const snap = await getLatestSnapshot()
    if (snap.result) {
      setData(snap.result)
      setSnapshotAt(snap.generatedAt)
      setIsStale(snap.stale)
      setHasData(true)
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback(
    (jobId: number) => {
      stopPolling()
      pollRef.current = setInterval(async () => {
        const status = await getAnalyticsJob(jobId)
        setJob(status)
        if (!status || status.status !== "running") {
          stopPolling()
          if (status?.status === "done") {
            await reloadSnapshot()
            toast.success("Analytics refreshed")
          } else if (status?.status === "error") {
            toast.error(status.error || "Refresh failed")
          }
        }
      }, POLL_MS)
    },
    [reloadSnapshot, stopPolling],
  )

  // Resume polling if a job was already running when the page loaded.
  useEffect(() => {
    if (initialJob && initialJob.status === "running") startPolling(initialJob.id)
    return () => stopPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh() {
    if (running) {
      toast.info("A refresh is already in progress")
      return
    }
    try {
      // Refresh the selected accounts (all of them when nothing is filtered).
      // A subset run merges its fresh numbers into the last full snapshot so the
      // untouched accounts keep their data.
      const { jobId, alreadyRunning } = await startAnalyticsRefresh(selected)
      const status = await getAnalyticsJob(jobId)
      setJob(status)
      startPolling(jobId)
      const scope = selected.length ? `${selected.length} selected account${selected.length > 1 ? "s" : ""}` : "all accounts"
      toast.message(alreadyRunning ? "Refresh already running" : `Refresh started — ${scope}`, {
        description:
          "Accounts are processed one-by-one in the background. Any account busy with another task is queued until it's free.",
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start refresh")
    }
  }

  function toggleAccount(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // Client-side filter of the cached snapshot (no new requests).
  const view = useMemo(() => {
    if (!selected.length) return data
    const accountsF = data.accounts.filter((a) => selected.includes(a.id))
    const reelsF = data.topReels.filter((r) => selected.includes(r.accountId))
    const views = accountsF.reduce((s, a) => s + a.views, 0)
    const likes = accountsF.reduce((s, a) => s + a.likes, 0)
    const comments = accountsF.reduce((s, a) => s + a.comments, 0)
    const reels = accountsF.reduce((s, a) => s + a.reels, 0)
    return {
      ...data,
      accounts: accountsF,
      topReels: reelsF,
      totals: {
        views,
        likes,
        comments,
        reels,
        accounts: accountsF.length,
        engagementRate: views > 0 ? ((likes + comments) / views) * 100 : 0,
      },
    } satisfies AnalyticsResult
  }, [data, selected])

  const updated =
    mounted && snapshotAt
      ? new Date(snapshotAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—"

  const accountLabel =
    selected.length === 0 ? "All accounts" : selected.length === 1 ? "1 account" : `${selected.length} accounts`

  const progressPct = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0

  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      {/* Filter / control bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="gap-2">
                <Users className="size-4" />
                {accountLabel}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Filter accounts</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {accounts.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No accounts</p>
              ) : (
                accounts.map((a) => (
                  <DropdownMenuCheckboxItem
                    key={a.id}
                    checked={selected.includes(a.id)}
                    onCheckedChange={() => toggleAccount(a.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    @{a.username || a.label}
                  </DropdownMenuCheckboxItem>
                ))
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="sm" className="gap-2" disabled={running} onClick={refresh}>
          <RefreshCw className={cn("size-4", running && "animate-spin")} />
          {running ? "Refreshing…" : "Refresh"}
        </Button>

        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {isStale && hasData && !running ? (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600">
              <Clock className="size-3" />
              Outdated
            </span>
          ) : null}
          Last updated: {updated}
        </span>
      </div>

      {/* Live progress while a refresh runs */}
      {running && job ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <RefreshCw className="size-4 animate-spin text-primary" />
              Refreshing analytics — {job.processed}/{job.total} accounts
            </span>
            <span className="text-xs text-muted-foreground">{progressPct}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progressPct}%` }} />
          </div>
          {(job.currentLabel || job.phase) && (
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {job.currentLabel ? `@${job.currentLabel}` : ""}
              {job.currentLabel && job.phase ? " — " : ""}
              {job.phase}
            </p>
          )}
        </div>
      ) : null}

      {!hasData && !running ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-24 text-center text-sm text-muted-foreground">
          <Clapperboard className="size-7 text-primary" />
          <div>
            <p className="font-medium text-foreground">No analytics yet</p>
            <p className="mt-1">Press Refresh to pull reel data from your accounts. This runs in the background.</p>
          </div>
        </div>
      ) : !hasData && running ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-24 text-sm text-muted-foreground">
          <RefreshCw className="size-6 animate-spin text-primary" />
          Pulling live reel data — accounts on shared proxies are paced one-by-one…
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Total Views" value={formatCompact(view.totals.views)} icon={Eye} chip="bg-[#4f5bd5]" />
            <Stat label="Total Likes" value={formatCompact(view.totals.likes)} icon={Heart} chip="bg-[#d62976]" />
            <Stat
              label="Avg Engagement"
              value={`${view.totals.engagementRate.toFixed(2)}%`}
              icon={TrendingUp}
              chip="bg-[#fa7e1e]"
            />
            <Stat label="Total Reels" value={formatCompact(view.totals.reels)} icon={Film} chip="bg-[#962fbf]" />
          </div>

          {/* Rankings: top accounts + top reels */}
          <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
            <TopAccounts accounts={view.accounts} />

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <Clapperboard className="size-4 text-[#d62976]" />
                  Top reels by views
                </h2>
                <span className="text-xs text-muted-foreground">Hover to play</span>
              </div>
              {view.topReels.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No reels found. Refresh to pull the latest reels.
                </p>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {view.topReels.map((reel, i) => (
                    <ReelCard key={`${reel.accountId}-${reel.id}`} reel={reel} rank={i + 1} />
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  icon: Icon,
  chip,
}: {
  label: string
  value: string
  icon: typeof Eye
  chip: string
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-transparent hover:ig-glow">
      <div className="pointer-events-none absolute -right-8 -top-8 size-28 rounded-full ig-gradient opacity-[0.07] blur-2xl transition-opacity duration-300 group-hover:opacity-20" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums ig-gradient-text">{value}</p>
        </div>
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-sm", chip)}>
          <Icon className="size-5" />
        </span>
      </div>
    </div>
  )
}
