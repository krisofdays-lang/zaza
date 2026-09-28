"use client"

import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Plus,
  Search,
  Workflow as WorkflowIcon,
  FileEdit,
  Play,
  Square,
  CheckCircle2,
  AlertCircle,
  Users,
  Layers,
  Check,
  GitBranch,
  Clock,
  Pencil,
  Trash2,
  Lock,
} from "lucide-react"
import { toast } from "sonner"
import {
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflowTargeting,
  deleteWorkflow,
  stopWorkflow,
} from "@/app/actions/workflows"
import { StatusBadge } from "@/components/status-badge"
import type { WorkflowSummary, WorkflowRunStatus } from "@/lib/workflows/run-types"

interface AccountOpt {
  id: number
  label: string
  username: string
  status: string
}
interface GroupOpt {
  id: number
  name: string
  accountIds?: number[]
  accountCount: number
}

const STATUS_META: Record<WorkflowRunStatus, { label: string; className: string }> = {
  draft: { label: "draft", className: "bg-muted text-muted-foreground" },
  running: { label: "running", className: "bg-emerald-500/15 text-emerald-400" },
  done: { label: "completed", className: "bg-sky-500/15 text-sky-400" },
  error: { label: "error", className: "bg-destructive/15 text-destructive" },
  cancelled: { label: "stopped", className: "bg-amber-500/15 text-amber-400" },
}

// Poll the list while any workflow is running so progress bars stay live.
const POLL_MS = 2000

export function WorkflowsView({
  initialWorkflows,
  accounts,
  groups,
}: {
  initialWorkflows: WorkflowSummary[]
  accounts: AccountOpt[]
  groups: GroupOpt[]
}) {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>(initialWorkflows)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  // Create / edit modal state. `editingId` is null when creating.
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [name, setName] = useState("")
  const [pickedAccounts, setPickedAccounts] = useState<Set<number>>(new Set())
  const [pickedGroups, setPickedGroups] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<WorkflowSummary | null>(null)

  // Live polling: refresh the list whenever something is running.
  const anyRunning = workflows.some((w) => w.status === "running")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!anyRunning) return
    let cancelled = false
    const tick = async () => {
      const next = await listWorkflows()
      if (cancelled) return
      setWorkflows(next)
      if (next.some((w) => w.status === "running")) timerRef.current = setTimeout(tick, POLL_MS)
    }
    timerRef.current = setTimeout(tick, POLL_MS)
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [anyRunning])

  const stats = useMemo(() => {
    const by = (s: WorkflowRunStatus) => workflows.filter((w) => w.status === s).length
    return {
      total: workflows.length,
      draft: by("draft"),
      running: by("running"),
      done: by("done"),
      error: by("error"),
    }
  }, [workflows])

  const filtered = useMemo(() => {
    return workflows.filter((w) => {
      const matchesQuery = w.name.toLowerCase().includes(query.trim().toLowerCase())
      const matchesStatus = statusFilter === "all" || w.status === statusFilter
      return matchesQuery && matchesStatus
    })
  }, [workflows, query, statusFilter])

  function toggle(set: React.Dispatch<React.SetStateAction<Set<number>>>, id: number) {
    set((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Which groups each account belongs to, so the Accounts list can show a chip
  // per account revealing its group membership at a glance.
  const groupsByAccount = useMemo(() => {
    const map = new Map<number, string[]>()
    for (const g of groups) {
      for (const id of g.accountIds ?? []) {
        const list = map.get(id) ?? []
        list.push(g.name)
        map.set(id, list)
      }
    }
    return map
  }, [groups])

  // Accounts on a challenge/checkpoint can't run automation, so they can't be
  // added to a workflow (they CAN still live in groups). Any such account is
  // filtered out of both the direct picks and the group-expanded picks.
  const blockedIds = useMemo(
    () => new Set(accounts.filter((a) => a.status === "checkpoint").map((a) => a.id)),
    [accounts],
  )

  // Resolve the concrete account ids from the picked accounts + groups.
  const resolvedAccountIds = useMemo(() => {
    const ids = new Set<number>()
    for (const id of pickedAccounts) if (!blockedIds.has(id)) ids.add(id)
    for (const g of groups) {
      if (pickedGroups.has(g.id)) for (const id of g.accountIds ?? []) if (!blockedIds.has(id)) ids.add(id)
    }
    return [...ids]
  }, [pickedAccounts, pickedGroups, groups, blockedIds])

  function resetModal() {
    setEditingId(null)
    setName("")
    setPickedAccounts(new Set())
    setPickedGroups(new Set())
  }

  function openCreate() {
    resetModal()
    setOpen(true)
  }

  async function openEdit(w: WorkflowSummary) {
    setEditingId(w.id)
    setName(w.name)
    // Pre-select the accounts this workflow already targets so editing the
    // selection is additive/subtractive instead of starting from scratch.
    setPickedAccounts(new Set())
    setPickedGroups(new Set())
    setOpen(true)
    const detail = await getWorkflow(w.id)
    if (detail) setPickedAccounts(new Set(detail.accountIds ?? []))
  }

  async function save() {
    if (resolvedAccountIds.length === 0) {
      toast.error("Select at least one account or group")
      return
    }
    setSaving(true)
    try {
      if (editingId) {
        // Update name + targeting in place. The server preserves the graph
        // (chain, actions, uploaded content) and only prunes the data of the
        // accounts that were removed from the selection.
        await updateWorkflowTargeting(editingId, {
          name: name.trim() || "Untitled Workflow",
          accountIds: resolvedAccountIds,
        })
        toast.success("Workflow updated")
        setOpen(false)
        resetModal()
        setWorkflows(await listWorkflows())
        return
      }
      const { id } = await createWorkflow(name.trim() || "Untitled Workflow", resolvedAccountIds)
      toast.success("Workflow created")
      setOpen(false)
      resetModal()
      router.push(`/workflows/${id}`)
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    setWorkflows((prev) => prev.filter((w) => w.id !== target.id))
    setDeleteTarget(null)
    await deleteWorkflow(target.id)
    toast.success("Workflow deleted")
  }

  async function handleStop(w: WorkflowSummary) {
    await stopWorkflow(w.id)
    toast.message("Stopping workflow…")
    setWorkflows(await listWorkflows())
  }

  const statCards = [
    { key: "total", label: "Total", value: stats.total, icon: GitBranch, color: "text-primary" },
    { key: "draft", label: "Draft", value: stats.draft, icon: FileEdit, color: "text-muted-foreground" },
    { key: "running", label: "Running", value: stats.running, icon: Play, color: "text-emerald-400" },
    { key: "done", label: "Completed", value: stats.done, icon: CheckCircle2, color: "text-sky-400" },
    { key: "error", label: "Error", value: stats.error, icon: AlertCircle, color: "text-destructive" },
  ]

  return (
    <div className="flex flex-col">
      <PageHeader title="Workflows" description="Build and manage automated action sequences.">
        <Button onClick={openCreate} className="ig-gradient text-white">
          <Plus className="size-4" /> Add workflow
        </Button>
      </PageHeader>

      <div className="space-y-5 px-6 py-5">
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {statCards.map((s) => {
            const Icon = s.icon
            return (
              <div key={s.key} className="relative overflow-hidden rounded-xl border border-border bg-card p-4">
                <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
                <p className={`mt-1 text-2xl font-semibold ${s.color}`}>{s.value}</p>
                <Icon className={`absolute -bottom-2 -right-1 size-12 opacity-10 ${s.color}`} strokeWidth={1.5} />
              </div>
            )
          })}
        </div>

        {/* Search + filter */}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workflows..."
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="sm:w-44">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="done">Completed</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="cancelled">Stopped</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
            <WorkflowIcon className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No workflows match your filters.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((w) => {
              const meta = STATUS_META[w.status]
              const pct = Math.round(w.percent * 100)
              const isRunning = w.status === "running"
              const showBar = isRunning || w.status === "done" || w.processed > 0
              return (
                <div
                  key={w.id}
                  className="group relative flex flex-col items-start rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/30"
                >
                  {/* Edit / delete controls — revealed on hover. */}
                  <div className="absolute right-3 top-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {isRunning ? (
                      <button
                        type="button"
                        aria-label={`Stop ${w.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleStop(w)
                        }}
                        className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Square className="size-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Edit ${w.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          openEdit(w)
                        }}
                        className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Delete ${w.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(w)
                      }}
                      className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {/* Main clickable area opens the editor. */}
                  <button
                    type="button"
                    onClick={() => router.push(`/workflows/${w.id}`)}
                    className="flex w-full flex-col items-start text-left"
                  >
                    <div className="flex w-full items-center justify-between gap-2 pr-16">
                      <h3 className="truncate font-semibold">{w.name}</h3>
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <GitBranch className="size-3.5" /> {w.actionsCount} node{w.actionsCount === 1 ? "" : "s"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="size-3.5" /> {w.accountCount} account{w.accountCount === 1 ? "" : "s"}
                      </span>
                    </div>

                    {/* Progress bar (live for running, full for completed). */}
                    {showBar && (
                      <div className="mt-3 w-full">
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span className="truncate">
                            {isRunning && w.currentLabel ? `@${w.currentLabel} — ${w.phase || "working"}` : meta.label}
                          </span>
                          <span className="tabular-nums">
                            {w.processed}/{w.total} · {pct}%
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className={`h-full transition-all ${
                              w.status === "error"
                                ? "bg-destructive"
                                : w.status === "cancelled"
                                  ? "bg-muted-foreground"
                                  : w.status === "done"
                                    ? "bg-emerald-500"
                                    : "ig-gradient"
                            }`}
                            style={{ width: `${w.status === "done" ? 100 : pct}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {!showBar && (
                      <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3.5" /> Not run yet
                      </span>
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Create modal */}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) resetModal()
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit workflow" : "New workflow"}</DialogTitle>
            <DialogDescription>Name it and choose the accounts or groups it will run on.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="wf-name">Name</Label>
              <Input
                id="wf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Untitled Workflow"
              />
            </div>

            {/* Groups */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Layers className="size-3.5" /> Groups
                </Label>
                <span className="text-xs text-muted-foreground">{pickedGroups.size} selected</span>
              </div>
              {groups.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
                  No groups yet.
                </p>
              ) : (
                <div className="grid max-h-40 gap-2 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                  {groups.map((g) => {
                    const on = pickedGroups.has(g.id)
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggle(setPickedGroups, g.id)}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                          on ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-accent"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{g.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{g.accountCount} accounts</p>
                        </div>
                        <span
                          className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                            on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                          }`}
                        >
                          {on && <Check className="size-3" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Accounts */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Users className="size-3.5" /> Accounts
                </Label>
                <span className="text-xs text-muted-foreground">{pickedAccounts.size} selected</span>
              </div>
              {accounts.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
                  No accounts yet.
                </p>
              ) : (
                <div className="grid max-h-[42vh] gap-2 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                  {accounts.map((a) => {
                    const on = pickedAccounts.has(a.id)
                    const blocked = blockedIds.has(a.id)
                    return (
                      <button
                        key={a.id}
                        type="button"
                        disabled={blocked}
                        title={blocked ? "On a challenge — resolve it before adding to a workflow" : undefined}
                        onClick={() => !blocked && toggle(setPickedAccounts, a.id)}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                          blocked
                            ? "cursor-not-allowed border-border bg-muted/40 opacity-60"
                            : on
                              ? "border-primary bg-primary/10"
                              : "border-border bg-card hover:bg-accent"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{a.label}</p>
                          {a.username && <p className="truncate text-xs text-muted-foreground">@{a.username}</p>}
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <StatusBadge status={a.status} />
                            {(groupsByAccount.get(a.id) ?? []).map((gname) => (
                              <span
                                key={gname}
                                className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground"
                              >
                                <Layers className="size-2.5 shrink-0" />
                                <span className="truncate">{gname}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                        <span
                          className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                            blocked
                              ? "border-border text-muted-foreground"
                              : on
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border"
                          }`}
                        >
                          {blocked ? <Lock className="size-3" /> : on && <Check className="size-3" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <span className="mr-auto self-center text-xs text-muted-foreground">
              {resolvedAccountIds.length} account{resolvedAccountIds.length === 1 ? "" : "s"} targeted
            </span>
            <Button onClick={save} className="ig-gradient text-white" disabled={saving}>
              {editingId ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete workflow?</DialogTitle>
            <DialogDescription>
              {deleteTarget ? `"${deleteTarget.name}" will be permanently removed. This cannot be undone.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              <Trash2 className="size-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
