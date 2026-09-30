"use client"

import { useState, useEffect, useTransition, useCallback } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Bot,
  Play,
  Square,
  RefreshCw,
  Download,
  Trash2,
  ArrowRightLeft,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Mail,
  Phone,
} from "lucide-react"
import type { IgAutoregAccount, IgAutoregLog, IgAutoregJob } from "@/lib/db/schema"
import {
  startAutoregAction,
  cancelAutoregAction,
  listAutoregLogs,
  listAutoregAccounts,
  getLatestAutoregJob,
  exportAutoregAccounts,
  deleteAutoregAccount,
  transferAutoregAccount,
  batchTransferAutoregAccounts,
  saveAutoregSettings,
  type AutoregSettings,
} from "@/app/actions/autoreg"

// ── Props ────────────────────────────────────────────────────────────────

interface AutoregViewProps {
  initialAccounts: IgAutoregAccount[]
  initialJob: IgAutoregJob | null
  initialLogs: IgAutoregLog[]
  platformUsers: { id: number; label: string; licenseKey: string }[]
  savedSettings: AutoregSettings
}

// ── Main Component ───────────────────────────────────────────────────────

export function AutoregView({
  initialAccounts,
  initialJob,
  initialLogs,
  platformUsers,
  savedSettings,
}: AutoregViewProps) {
  const [tab, setTab] = useState<"config" | "logs" | "accounts">("config")
  const [job, setJob] = useState<IgAutoregJob | null>(initialJob)
  const [logs, setLogs] = useState<IgAutoregLog[]>(initialLogs)
  const [accounts, setAccounts] = useState<IgAutoregAccount[]>(initialAccounts)
  const [isPending, startTransition] = useTransition()

  // ── Config state ─────────────────────────────────────────────────────
  const [method, setMethod] = useState<"email" | "sms">("email")
  const [threads, setThreads] = useState(4)
  const [targetCount, setTargetCount] = useState(5)
  const [proxiesText, setProxiesText] = useState("")
  const [anymessageKey, setAnymessageKey] = useState(savedSettings.anymessageKey || "")
  const [anymessageDomain, setAnymessageDomain] = useState<string>(savedSettings.anymessageDomain || "gmail")
  const [textverifiedToken, setTextverifiedToken] = useState(savedSettings.textverifiedToken || "")
  const [groupLabel, setGroupLabel] = useState("")

  const handleSaveKeys = useCallback(() => {
    startTransition(async () => {
      const res = await saveAutoregSettings({
        anymessageKey,
        anymessageDomain,
        textverifiedToken,
      })
      if (res.ok) toast.success("API keys saved")
      else toast.error("Failed to save keys")
    })
  }, [anymessageKey, anymessageDomain, textverifiedToken])

  // ── Transfer state ───────────────────────────────────────────────────
  const [transferUserId, setTransferUserId] = useState<number | null>(platformUsers[0]?.id ?? null)
  const [selectedAccounts, setSelectedAccounts] = useState<Set<number>>(new Set())

  // ── Polling for live updates ─────────────────────────────────────────
  const isRunning = job?.status === "running"
  const [wasRunning, setWasRunning] = useState(false)

  useEffect(() => {
    if (isRunning) {
      setWasRunning(true)
    } else if (wasRunning) {
      setWasRunning(false)
      listAutoregAccounts().then(setAccounts)
      if (job?.jobId) listAutoregLogs(job.jobId).then(setLogs)
    }
  }, [isRunning, wasRunning, job?.jobId])

  useEffect(() => {
    if (!isRunning) return
    const interval = setInterval(() => {
      getLatestAutoregJob().then((j) => {
        if (j) setJob(j)
      })
      if (job?.jobId) {
        listAutoregLogs(job.jobId).then(setLogs)
      }
      listAutoregAccounts().then(setAccounts)
    }, 2_000)
    return () => clearInterval(interval)
  }, [isRunning, job?.jobId])

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleStart = useCallback(() => {
    const proxies = proxiesText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)

    startTransition(async () => {
      const res = await startAutoregAction({
        method,
        threads,
        targetCount,
        proxies,
        anymessageApiKey: method === "email" ? anymessageKey : undefined,
        anymessageDomain: method === "email" ? anymessageDomain : undefined,
        textverifiedToken: method === "sms" ? textverifiedToken : undefined,
        groupLabel: groupLabel || undefined,
      })
      if (res.ok) {
        toast.success(`Job started: ${res.jobId?.slice(0, 8)}…`)
        setTab("logs")
        // Refresh
        const j = await getLatestAutoregJob()
        if (j) {
          setJob(j)
          listAutoregLogs(j.jobId).then(setLogs)
        }
      } else {
        toast.error(res.error || "Failed to start job")
      }
    })
  }, [method, threads, targetCount, proxiesText, anymessageKey, anymessageDomain, textverifiedToken, groupLabel])

  const handleCancel = useCallback(() => {
    if (!job?.jobId) return
    startTransition(async () => {
      await cancelAutoregAction(job.jobId)
      toast.info("Cancel requested")
    })
  }, [job?.jobId])

  const handleExport = useCallback(() => {
    startTransition(async () => {
      const ids = selectedAccounts.size > 0 ? [...selectedAccounts] : undefined
      const text = await exportAutoregAccounts(ids)
      // Copy to clipboard
      await navigator.clipboard.writeText(text)
      toast.success(`Exported ${text.split("\n").length} accounts to clipboard`)
    })
  }, [selectedAccounts])

  const handleDelete = useCallback((id: number) => {
    startTransition(async () => {
      await deleteAutoregAccount(id)
      setAccounts((prev) => prev.filter((a) => a.id !== id))
      toast.success("Account deleted")
    })
  }, [])

  const handleTransfer = useCallback((accountId: number) => {
    if (!transferUserId) return
    startTransition(async () => {
      const res = await transferAutoregAccount(accountId, transferUserId)
      if (res.ok) {
        toast.success(`Transferred to user #${transferUserId}`)
        listAutoregAccounts().then(setAccounts)
      } else {
        toast.error(res.error || "Transfer failed")
      }
    })
  }, [transferUserId])

  const handleBatchTransfer = useCallback(() => {
    if (!transferUserId || selectedAccounts.size === 0) return
    startTransition(async () => {
      const res = await batchTransferAutoregAccounts([...selectedAccounts], transferUserId)
      toast.success(`Transferred ${res.transferred} accounts`)
      if (res.errors.length) toast.error(res.errors.join("; "))
      setSelectedAccounts(new Set())
      listAutoregAccounts().then(setAccounts)
    })
  }, [transferUserId, selectedAccounts])

  const handleRefreshAccounts = useCallback(() => {
    startTransition(async () => {
      const accs = await listAutoregAccounts()
      setAccounts(accs)
      toast.success("Refreshed")
    })
  }, [])

  const toggleSelectAccount = (id: number) => {
    setSelectedAccounts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllAccounts = () => {
    const created = accounts.filter((a) => a.status === "created")
    if (selectedAccounts.size === created.length) {
      setSelectedAccounts(new Set())
    } else {
      setSelectedAccounts(new Set(created.map((a) => a.id)))
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {(["config", "logs", "accounts"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "config" && "Configuration"}
            {t === "logs" && `Logs${logs.length ? ` (${logs.length})` : ""}`}
            {t === "accounts" && `Accounts (${accounts.filter((a) => a.status === "created").length})`}
          </button>
        ))}
      </div>

      {/* Job status banner */}
      {job && job.status === "running" && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 shadow-[0_0_20px_-6px_oklch(0.55_0.16_260/18%)]">
          <Loader2 className="size-4 animate-spin text-blue-500" />
          <div className="flex-1 text-sm">
            <span className="font-medium">Job running</span>
            <span className="text-muted-foreground ml-2">
              {job.completed}/{job.targetCount} completed · {job.failed} failed · {job.threads} threads
            </span>
          </div>
          <button
            onClick={handleCancel}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/20 transition-colors"
          >
            <Square className="size-3" />
            Stop
          </button>
        </div>
      )}

      {/* Config tab */}
      {tab === "config" && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left: Settings */}
          <div className="space-y-5">
            <div className="rounded-xl border border-border bg-card p-5 space-y-4 velvet-card velvet-surface">
              <h3 className="text-sm font-semibold">Registration Method</h3>
              <div className="flex gap-2">
                {(["email", "sms"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all",
                      method === m
                        ? "ig-gradient text-white shadow-md"
                        : "border border-border text-muted-foreground hover:bg-sidebar-accent/60",
                    )}
                  >
                    {m === "email" ? <Mail className="size-4" /> : <Phone className="size-4" />}
                    {m === "email" ? "Email (AnyMessage)" : "SMS (TextVerified)"}
                  </button>
                ))}
              </div>

              {method === "email" && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                      AnyMessage API Key
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={anymessageKey}
                        onChange={(e) => setAnymessageKey(e.target.value)}
                        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        placeholder="Enter API key…"
                      />
                      <button
                        type="button"
                        onClick={handleSaveKeys}
                        className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent/60 transition-all"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                      Anymessage Domain
                    </label>
                    <div className="flex gap-2">
                      {(["gmail", "icloud", "outlook"] as const).map((d) => (
                        <button
                          key={d}
                          onClick={() => setAnymessageDomain(d)}
                          className={cn(
                            "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-all",
                            anymessageDomain === d
                              ? "ig-gradient text-white shadow-md"
                              : "border border-border text-muted-foreground hover:bg-sidebar-accent/60",
                          )}
                        >
                          {d.charAt(0).toUpperCase() + d.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {method === "sms" && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    TextVerified Bearer Token
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={textverifiedToken}
                      onChange={(e) => setTextverifiedToken(e.target.value)}
                      className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      placeholder="Enter bearer token…"
                    />
                    <button
                      type="button"
                      onClick={handleSaveKeys}
                      className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent/60 transition-all"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-5 space-y-4 velvet-card velvet-surface">
              <h3 className="text-sm font-semibold">Concurrency</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    Threads
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={threads}
                    onChange={(e) => setThreads(Number(e.target.value))}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    Target Count
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={targetCount}
                    onChange={(e) => setTargetCount(Number(e.target.value))}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 space-y-4 velvet-card velvet-surface">
              <h3 className="text-sm font-semibold">Group Label</h3>
              <input
                type="text"
                value={groupLabel}
                onChange={(e) => setGroupLabel(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Optional batch label…"
              />
            </div>
          </div>

          {/* Right: Proxies + Start */}
          <div className="space-y-5">
            <div className="rounded-xl border border-border bg-card p-5 space-y-4 velvet-card velvet-surface">
              <h3 className="text-sm font-semibold">Proxies</h3>
              <p className="text-xs text-muted-foreground">
                One proxy per line. Format: http://user:pass@host:port or socks5://host:port
              </p>
              <textarea
                value={proxiesText}
                onChange={(e) => setProxiesText(e.target.value)}
                rows={10}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y"
                placeholder={"http://user:pass@proxy1:8080\nhttp://user:pass@proxy2:8080\nsocks5://proxy3:1080"}
              />
              <p className="text-xs text-muted-foreground">
                {proxiesText.split("\n").filter((l) => l.trim()).length} proxies loaded
              </p>
            </div>

            <button
              onClick={handleStart}
              disabled={isPending || isRunning}
              className="w-full flex items-center justify-center gap-2 rounded-xl ig-gradient px-4 py-3 text-sm font-semibold text-white shadow-md hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Start Registration ({targetCount} accounts, {threads} threads)
            </button>
          </div>
        </div>
      )}

      {/* Logs tab */}
      {tab === "logs" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Registration Logs
              {job && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  Job: {job.jobId.slice(0, 8)}… · {job.status}
                </span>
              )}
            </h3>
            <button
              onClick={() => {
                if (job?.jobId) listAutoregLogs(job.jobId).then(setLogs)
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3" />
              Refresh
            </button>
          </div>

          <div className="rounded-xl border border-border overflow-hidden velvet-card">
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur-sm border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">#</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Method</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Username</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Contact</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Step</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Detail</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                        No logs yet. Start a job to see registration attempts.
                      </td>
                    </tr>
                  )}
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b border-border/50 hover:bg-sidebar-accent/30">
                      <td className="px-3 py-2 text-xs text-muted-foreground">{log.threadIndex}</td>
                      <td className="px-3 py-2">
                        <LogStatusBadge status={log.status} />
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {log.method === "email" ? (
                          <span className="flex items-center gap-1"><Mail className="size-3" /> Email</span>
                        ) : (
                          <span className="flex items-center gap-1"><Phone className="size-3" /> SMS</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{log.username || "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs truncate max-w-[150px]">
                        {log.email || log.phone || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{log.step}</td>
                      <td className={cn(
                        "px-3 py-2 text-xs truncate max-w-[300px]",
                        log.status === "error" ? "text-red-400" : "text-emerald-400/70",
                      )} title={log.status === "error" ? log.error : log.stepDetail}>
                        {log.status === "error" ? (log.error || "—") : (log.stepDetail || "—")}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {log.startedAt ? new Date(log.startedAt).toLocaleTimeString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Accounts tab */}
      {tab === "accounts" && (
        <div className="space-y-4">
          {/* Actions bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleRefreshAccounts}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/60 transition-colors"
            >
              <RefreshCw className={cn("size-3", isPending && "animate-spin")} />
              Refresh
            </button>

            <button
              onClick={handleExport}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/60 transition-colors"
            >
              <Download className="size-3" />
              Export{selectedAccounts.size > 0 ? ` (${selectedAccounts.size})` : " all"}
            </button>

            <div className="ml-auto flex items-center gap-2">
              <select
                value={transferUserId ?? ""}
                onChange={(e) => setTransferUserId(Number(e.target.value) || null)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {platformUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label} (••••{u.licenseKey.slice(-4)})
                  </option>
                ))}
              </select>
              <button
                onClick={handleBatchTransfer}
                disabled={isPending || selectedAccounts.size === 0 || !transferUserId}
                className="flex items-center gap-1.5 rounded-lg ig-gradient px-3 py-2 text-xs font-medium text-white shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <ArrowRightLeft className="size-3" />
                Transfer ({selectedAccounts.size})
              </button>
            </div>
          </div>

          {/* Accounts table */}
          <div className="rounded-xl border border-border overflow-hidden velvet-card">
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card/95 backdrop-blur-sm border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left">
                      <input
                        type="checkbox"
                        checked={
                          selectedAccounts.size > 0 &&
                          selectedAccounts.size === accounts.filter((a) => a.status === "created").length
                        }
                        onChange={selectAllAccounts}
                        className="rounded"
                      />
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Username</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Method</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Contact</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Proxy</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Group</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Created</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                        No accounts yet. Run a registration job to create accounts.
                      </td>
                    </tr>
                  )}
                  {accounts.map((acct) => (
                    <tr key={acct.id} className="border-b border-border/50 hover:bg-sidebar-accent/30">
                      <td className="px-3 py-2">
                        {acct.status === "created" && (
                          <input
                            type="checkbox"
                            checked={selectedAccounts.has(acct.id)}
                            onChange={() => toggleSelectAccount(acct.id)}
                            className="rounded"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs font-medium">{acct.username}</td>
                      <td className="px-3 py-2 text-xs">
                        {acct.regMethod === "email" ? (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Mail className="size-3" /> Email
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Phone className="size-3" /> SMS
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs truncate max-w-[150px]">
                        {acct.email || acct.phone || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs truncate max-w-[120px] text-muted-foreground">
                        {acct.proxyUrl ? maskProxy(acct.proxyUrl) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{acct.groupLabel || "—"}</td>
                      <td className="px-3 py-2">
                        <AccountStatusBadge status={acct.status} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {acct.createdAt ? new Date(acct.createdAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {acct.status === "created" && (
                            <button
                              onClick={() => handleTransfer(acct.id)}
                              disabled={isPending || !transferUserId}
                              title="Transfer to user"
                              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/60 transition-colors"
                            >
                              <ArrowRightLeft className="size-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(acct.id)}
                            disabled={isPending}
                            title="Delete"
                            className="rounded p-1 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────

function LogStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-500">
          <Loader2 className="size-2.5 animate-spin" /> Running
        </span>
      )
    case "success":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
          <CheckCircle2 className="size-2.5" /> Success
        </span>
      )
    case "error":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-500">
          <XCircle className="size-2.5" /> Error
        </span>
      )
    case "cancelled":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-semibold text-yellow-500">
          <Clock className="size-2.5" /> Cancelled
        </span>
      )
    default:
      return <span className="text-xs text-muted-foreground">{status}</span>
  }
}

function AccountStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "created":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-500">
          <CheckCircle2 className="size-2.5" /> Created
        </span>
      )
    case "transferred":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-500">
          <ArrowRightLeft className="size-2.5" /> Transferred
        </span>
      )
    case "banned":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-500">
          <XCircle className="size-2.5" /> Banned
        </span>
      )
    default:
      return <span className="text-xs text-muted-foreground">{status}</span>
  }
}

function maskProxy(proxy: string): string {
  try {
    const url = new URL(proxy)
    return `${url.protocol}//${url.hostname}:${url.port}`
  } catch {
    return proxy.slice(0, 20) + "…"
  }
}
