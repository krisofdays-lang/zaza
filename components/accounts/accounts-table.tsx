"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/status-badge"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getPreset } from "@/lib/instagram/devices"
import { deleteAccount, refreshAccountProfile, rotateAccountProxy, bulkDeleteAccounts, bulkRefreshAccounts, getAccountStatuses, type AccountStatus } from "@/app/actions/accounts"
import { addAccountToGroups } from "@/app/actions/groups"
import { IphoneFrame } from "@/components/iphone-frame"
import { InstagramPhone } from "@/components/accounts/instagram-phone"
import { AccountFormDialog } from "@/components/accounts/account-form-dialog"
import { ChallengeDialog } from "@/components/accounts/challenge-dialog"
import type { DisplayAccount } from "@/app/actions/accounts"
import { MoreVertical, RefreshCw, RotateCw, Trash2, Smartphone, Wifi, ShieldOff, Loader2, FolderPlus, Pencil, Search } from "lucide-react"

type ProfileShape = {
  profile_pic_url?: string
  full_name?: string
  follower_count?: number
  following_count?: number
  media_count?: number
}

type GroupOption = { id: number; name: string }
type SortKey = "group" | "username" | "status" | "followers" | "views"

export function AccountsTable({
  accounts,
  groups = [],
  groupNamesByAccount = {},
}: {
  accounts: DisplayAccount[]
  groups?: GroupOption[]
  groupNamesByAccount?: Record<number, string[]>
}) {
  // Ids hidden from the list immediately on delete — pure local state, no
  // transition involved, so it never blocks Next.js navigation.
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set())

  // Live-status overlay: polls getAccountStatuses() every 3 s while any account
  // is being refreshed (refreshingIds is non-empty). Merges fresh status, avatar
  // and username into the initial props so updates appear without a page refresh.
  const [statusOverrides, setStatusOverrides] = useState<Map<number, AccountStatus>>(new Map())
  // Maps account ID → timestamp when we started watching it. Polling runs
  // while this map is non-empty and auto-clears an ID once its lastCheckedAt
  // moves past the recorded timestamp (meaning the after() callback finished).
  const [refreshingIds, setRefreshingIds] = useState<Map<number, number>>(new Map())
  const hiddenRef = useRef(false)
  // Map account id → toast id so we can dismiss loading toasts on settlement.
  const loadingToastsRef = useRef<Map<number, string | number>>(new Map())
  const isPolling = refreshingIds.size > 0

  // Auto-detect newly added accounts whose profile hasn't loaded yet.
  // When the parent RSC re-renders after createAccount(), the new account
  // appears in the `accounts` prop — start polling for it so the avatar /
  // status update appears without a manual page refresh.
  const prevAccountIdsRef = useRef<Set<number>>(new Set(accounts.map((a) => a.id)))
  useEffect(() => {
    const prevIds = prevAccountIdsRef.current
    const newIds = accounts.filter((a) => !prevIds.has(a.id)).map((a) => a.id)
    prevAccountIdsRef.current = new Set(accounts.map((a) => a.id))
    if (newIds.length > 0) {
      const now = Date.now()
      setRefreshingIds((s) => {
        const next = new Map(s)
        newIds.forEach((id) => next.set(id, now))
        return next
      })
    }
  }, [accounts])

  useEffect(() => {
    if (!isPolling) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (cancelled) return
      if (hiddenRef.current) {
        timer = setTimeout(tick, 3000)
        return
      }
      try {
        const fresh = await getAccountStatuses()
        if (cancelled) return
        const map = new Map<number, AccountStatus>()
        for (const s of fresh) map.set(s.id, s)
        setStatusOverrides(map)
        // Determine which IDs have settled (lastCheckedAt moved past start
        // timestamp) or timed out, clear them, and show a notification.
        const now = Date.now()
        const settled: { id: number; status: AccountStatus | undefined }[] = []
        setRefreshingIds((prev) => {
          const next = new Map(prev)
          for (const [id, startedAt] of prev) {
            // Safety timeout — stop polling after 60 s.
            if (now - startedAt > 60_000) {
              next.delete(id)
              settled.push({ id, status: map.get(id) })
              continue
            }
            const s = map.get(id)
            if (s && s.lastCheckedAt) {
              const checkedMs = new Date(s.lastCheckedAt).getTime()
              if (checkedMs > startedAt) {
                next.delete(id)
                settled.push({ id, status: s })
              }
            }
          }
          return next
        })
        // Dismiss loading toasts and show completion toasts.
        if (settled.length > 0) {
          // Dismiss all loading toasts for settled accounts.
          const dismissedToastIds = new Set<string | number>()
          for (const s of settled) {
            const tid = loadingToastsRef.current.get(s.id)
            if (tid !== undefined && !dismissedToastIds.has(tid)) {
              toast.dismiss(tid)
              dismissedToastIds.add(tid)
            }
            loadingToastsRef.current.delete(s.id)
          }
          const ok = settled.filter((s) => s.status?.status === "ok" || s.status?.status === "active")
          const failed = settled.filter((s) => s.status && s.status.status !== "ok" && s.status.status !== "active")
          if (ok.length === 1) {
            const name = ok[0].status?.username ?? `#${ok[0].id}`
            toast.success(`Profile updated: @${name}`)
          } else if (ok.length > 1) {
            toast.success(`${ok.length} profiles updated`)
          }
          for (const f of failed) {
            const name = f.status?.username ?? `#${f.id}`
            toast.error(`Refresh failed: @${name}`, {
              description: f.status?.lastError ?? f.status?.status ?? "unknown error",
            })
          }
        }
      } catch {
        // ignore transient errors
      }
      if (!cancelled) timer = setTimeout(tick, 3000)
    }
    const onVisibility = () => {
      hiddenRef.current = document.visibilityState === "hidden"
    }
    document.addEventListener("visibilitychange", onVisibility)
    timer = setTimeout(tick, 1500) // first poll 1.5 s after action fires
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [isPolling])

  // Merge fresh status overrides into the prop-provided accounts.
  const mergedAccounts = useMemo(() => {
    if (statusOverrides.size === 0) return accounts
    return accounts.map((a) => {
      const s = statusOverrides.get(a.id)
      if (!s) return a
      return { ...a, status: s.status, username: s.username, profile: s.profile, recentReelViews: s.recentReelViews, lastError: s.lastError, lastCheckedAt: s.lastCheckedAt }
    })
  }, [accounts, statusOverrides])

  const visibleAccounts = useMemo(
    () => mergedAccounts.filter((a) => !removedIds.has(a.id)),
    [mergedAccounts, removedIds],
  )
  const [open, setOpen] = useState<DisplayAccount | null>(null)
  const [editTarget, setEditTarget] = useState<DisplayAccount | null>(null)
  const [challengeTarget, setChallengeTarget] = useState<DisplayAccount | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [groupTarget, setGroupTarget] = useState<DisplayAccount | null>(null)
  const [chosenGroups, setChosenGroups] = useState<number[]>([])
  const [savingGroups, setSavingGroups] = useState(false)
  const [rotatingId, setRotatingId] = useState<number | null>(null)

  // Search / filter / sort controls.
  const [query, setQuery] = useState("")
  const [groupFilter, setGroupFilter] = useState("all")
  const [sort, setSort] = useState<SortKey>("group")

  const groupsOf = (id: number) => groupNamesByAccount[id] ?? []

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = visibleAccounts.filter((a) => {
      const handle = (a.username || a.label || "").toLowerCase()
      const matchesQuery = !q || handle.includes(q) || (a.label || "").toLowerCase().includes(q)
      const names = groupsOf(a.id)
      const matchesGroup =
        groupFilter === "all" ||
        (groupFilter === "none" ? names.length === 0 : names.includes(groupFilter))
      return matchesQuery && matchesGroup
    })
    return [...list].sort((a, b) => {
      const ha = a.username || a.label || `Account ${a.id}`
      const hb = b.username || b.label || `Account ${b.id}`
      if (sort === "username") return ha.localeCompare(hb)
      if (sort === "status") return (a.status || "").localeCompare(b.status || "")
      if (sort === "followers") {
        const fa = ((a.profile as ProfileShape)?.follower_count) ?? 0
        const fb = ((b.profile as ProfileShape)?.follower_count) ?? 0
        return fb - fa
      }
      if (sort === "views") {
        return (b.recentReelViews ?? 0) - (a.recentReelViews ?? 0)
      }
      // group: by first group name (empty sorts last), then username
      const ga = groupsOf(a.id)[0] ?? "~"
      const gb = groupsOf(b.id)[0] ?? "~"
      return ga.localeCompare(gb) || ha.localeCompare(hb)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleAccounts, query, groupFilter, sort, groupNamesByAccount])

  // Manually rotate the account's proxy IP (triggered by the reload icon next to
  // the proxy address). Shows a toast with the success/failure result.
  async function handleRotate(a: DisplayAccount) {
    if (rotatingId != null) return
    if (!a.rotationUrl) {
      toast.info("No rotation link configured for this account.")
      return
    }
    setRotatingId(a.id)
    const toastId = toast.loading(`Rotating proxy for ${a.username || a.label || "account"}…`)
    const res = await rotateAccountProxy(a.id)
    setRotatingId(null)
    if (res.ok) {
      toast.success("Proxy rotated successfully", { id: toastId })
    } else {
      toast.error("Proxy rotation failed", { id: toastId, description: res.error })
    }
  }

  function openGroupDialog(a: DisplayAccount) {
    setChosenGroups([])
    setGroupTarget(a)
  }

  async function saveGroups() {
    if (!groupTarget) return
    setSavingGroups(true)
    addAccountToGroups(groupTarget.id, chosenGroups)
      .finally(() => setSavingGroups(false))
    setGroupTarget(null)
    toast.success("Account added to group(s)")
  }

  const allSelected = rows.length > 0 && rows.every((a) => selected.includes(a.id))
  const someSelected = selected.length > 0 && !allSelected

  function toggleOne(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function toggleAll() {
    setSelected((prev) => (rows.every((a) => prev.includes(a.id)) ? [] : rows.map((a) => a.id)))
  }

  // ── Fire-and-forget handlers ─────────────────────────────────────────
  // None of these await or use startTransition, so they NEVER block the
  // Next.js router. The server action returns almost instantly (heavy work
  // runs in after()), and revalidatePath on the server ensures the next
  // page render gets fresh data.

  function handleRefresh(id: number) {
    const startedAt = Date.now()
    setRefreshingIds((s) => new Map(s).set(id, startedAt))
    const acct = visibleAccounts.find((a) => a.id === id)
    const toastId = toast.loading(`Refreshing @${acct?.username ?? id}…`)
    loadingToastsRef.current.set(id, toastId)
    // Fire-and-forget — the server action returns almost instantly (heavy
    // work runs in after()). The polling effect auto-clears refreshingIds
    // once the account's lastCheckedAt moves past `startedAt`.
    refreshAccountProfile(id)
  }

  function handleDelete(id: number) {
    // Instantly hide from the list — no transition, no blocking.
    setRemovedIds((s) => new Set(s).add(id))
    setSelected((prev) => prev.filter((x) => x !== id))
    toast.success("Account removed")
    // Fire and forget — server action returns fast, cleanup in after().
    deleteAccount(id)
  }

  function bulkRefresh() {
    const ids = [...selected]
    const startedAt = Date.now() + 2000
    setRefreshingIds((s) => {
      const next = new Map(s)
      ids.forEach((id) => next.set(id, startedAt))
      return next
    })
    const toastId = toast.loading(`Refreshing ${ids.length} account(s)…`)
    ids.forEach((id) => loadingToastsRef.current.set(id, toastId))
    // Fire-and-forget — polling auto-clears each ID once settled.
    bulkRefreshAccounts(ids)
  }

  function bulkDelete() {
    const toDelete = [...selected]
    // Instantly hide all from the list.
    setRemovedIds((s) => {
      const next = new Set(s)
      toDelete.forEach((id) => next.add(id))
      return next
    })
    setSelected([])
    toast.success(`Removed ${toDelete.length} account(s)`)
    // Single request — all IDs in one fetch, can't be partially aborted.
    bulkDeleteAccounts(toDelete)
  }

  const selectClass =
    "h-9 rounded-lg border border-input bg-secondary/40 px-3 text-sm outline-none transition-colors focus:border-[#d62976]"

  if (!visibleAccounts.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
        <p className="text-sm font-medium">No accounts yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Add your first account to start automating.</p>
      </div>
    )
  }

  return (
    <>
      {/* Search / filter / sort controls */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by username…"
            className="h-9 w-full rounded-lg border border-input bg-secondary/40 pl-9 pr-3 text-sm outline-none transition-colors focus:border-[#d62976]"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="acc-group">
            Filter by group
          </label>
          <select id="acc-group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className={selectClass}>
            <option value="all">All groups</option>
            <option value="none">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="acc-sort">
            Sort by
          </label>
          <select id="acc-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectClass}>
            <option value="group">Sort: Group</option>
            <option value="username">Sort: Username</option>
            <option value="status">Sort: Status</option>
            <option value="followers">Sort: Followers</option>
            <option value="views">Sort: Reel views</option>
          </select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5">
          <span className="text-sm font-medium">{selected.length} selected</span>
          <Button variant="outline" size="sm" onClick={bulkRefresh}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={bulkDelete} className="text-destructive">
            <Trash2 className="size-4" /> Delete
          </Button>
          <button onClick={() => setSelected([])} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            Clear
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* Header row */}
        <div className="hidden grid-cols-[36px_minmax(0,1fr)_84px_96px_110px_252px_104px_56px] gap-3 border-b border-border bg-secondary/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:grid">
          <input
            type="checkbox"
            aria-label="Select all accounts"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected
            }}
            onChange={toggleAll}
            className="size-4 self-center accent-[#d62976]"
          />
          <span>Account</span>
          <span>Followers</span>
          <span>Reel views</span>
          <span>Last post</span>
          <span>Device</span>
          <span>Status</span>
          <span className="text-right">Actions</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">No accounts match your filters.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((a) => {
              const profile = (a.profile ?? {}) as ProfileShape
              const preset = getPreset(a.iphoneModel)
              const busy = refreshingIds.has(a.id)
              const handle = a.username || a.label || `Account ${a.id}`
              const names = groupsOf(a.id)
              return (
                <li
                  key={a.id}
                  className={`grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/30 md:grid-cols-[36px_minmax(0,1fr)_84px_96px_110px_252px_104px_56px] ${
                    selected.includes(a.id) ? "bg-secondary/40" : ""
                  }`}
                >
                  {/* Select */}
                  <input
                    type="checkbox"
                    aria-label={`Select ${handle}`}
                    checked={selected.includes(a.id)}
                    onChange={() => toggleOne(a.id)}
                    className="size-4 self-center accent-[#d62976]"
                  />

                  {/* Account */}
                  <button
                    onClick={() => setOpen(a)}
                    className="flex min-w-0 items-center gap-3 text-left"
                  >
                    <div className="shrink-0 rounded-full bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] p-[2px]">
                      <Avatar className="size-10 border-2 border-card">
                        <AvatarImage src={profile.profile_pic_url || "/placeholder.svg"} alt={handle} referrerPolicy="no-referrer" />
                        <AvatarFallback className="bg-secondary text-xs">
                          {handle.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    </div>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate font-medium">
                        {handle}
                        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
                      </p>
                      <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        {names.length ? (
                          <span className="truncate rounded-full bg-secondary px-2 py-0.5 text-[10px] text-foreground/80">
                            {names.join(", ")}
                          </span>
                        ) : null}
                        <span className="truncate">
                          {profile.full_name || (a.igUserId ? `id ${a.igUserId}` : "tap to open phone")}
                        </span>
                      </p>
                    </div>
                  </button>

                  {/* Followers */}
                  <div className="hidden text-sm tabular-nums md:block">
                    {profile.follower_count != null ? formatCount(profile.follower_count) : "—"}
                  </div>

                  {/* Reel views (sum of last 6 reels) */}
                  <div
                    className="hidden text-sm tabular-nums md:block"
                    title="Total views across the 6 most recent reels"
                  >
                    {a.recentReelViews != null ? formatCount(a.recentReelViews) : "—"}
                  </div>

                  {/* Last media post (reel / post / carousel — not stories) */}
                  <div
                    className="hidden text-sm text-muted-foreground md:block"
                    title={a.lastPostAt ? new Date(a.lastPostAt).toLocaleString() : "No media posted yet"}
                  >
                    {formatLastPost(a.lastPostAt)}
                  </div>

                  {/* Device + proxy */}
                  <div className="hidden min-w-0 flex-col gap-0.5 text-xs text-muted-foreground md:flex">
                    <span className="flex items-center gap-1.5">
                      {a.proxyType !== "none" ? (
                        <Wifi className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <ShieldOff className="size-3.5 shrink-0 text-muted-foreground/60" />
                      )}
                      <span className="truncate">{preset.name}</span>
                    </span>
                    {formatProxy(a.proxyType, a.proxyUrl) ? (
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[10px] text-foreground/70" title={formatProxy(a.proxyType, a.proxyUrl)!}>
                          {formatProxy(a.proxyType, a.proxyUrl)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRotate(a)}
                          disabled={rotatingId === a.id}
                          title="Rotate proxy IP"
                          aria-label="Rotate proxy IP"
                          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:opacity-60"
                        >
                          {rotatingId === a.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RotateCw className="size-3.5" />
                          )}
                        </button>
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/60">No proxy</span>
                    )}
                  </div>

                  {/* Status */}
                  <div className="hidden md:block">
                    {a.status === "checkpoint" ? (
                      <button
                        type="button"
                        onClick={() => setChallengeTarget(a)}
                        title="Resolve challenge"
                        className="rounded-full outline-none ring-offset-2 ring-offset-background transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-chart-4"
                      >
                        <StatusBadge status={a.status} title={a.lastError || undefined} />
                      </button>
                    ) : (
                      <StatusBadge status={a.status} title={a.lastError || undefined} />
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon" className="size-8 shrink-0">
                            <MoreVertical className="size-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setOpen(a)}>
                          <Smartphone className="size-4" /> Open phone
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditTarget(a)}>
                          <Pencil className="size-4" /> Edit account
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleRefresh(a.id)} disabled={busy}>
                          <RefreshCw className="size-4" /> Refresh profile
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openGroupDialog(a)} disabled={!groups.length}>
                          <FolderPlus className="size-4" /> Add to group
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => handleDelete(a.id)}>
                          <Trash2 className="size-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/*
        disablePointerDismissal: the phone has its own bottom-nav navigation, and
        switching tabs re-renders the screen subtree. The transformed iPhone frame
        confuses Base UI's pointer "contains" check, so in-phone clicks get misread
        as outside presses and close the modal. Disable pointer dismissal and rely
        on the X button / Escape to close instead.
      */}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)} disablePointerDismissal>
        <DialogContent showCloseButton className="max-w-[420px] border-none bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">{open?.username || open?.label || "Account"} phone</DialogTitle>
          {open && (
            <div className="flex flex-col items-center gap-3">
              <IphoneFrame batteryLevel={18}>
                <InstagramPhone account={open} />
              </IphoneFrame>
              <p className="max-w-[300px] text-center text-xs text-white/70">
                Tap the bottom nav to switch feeds. Tap any post to like, comment or like comments — every call goes
                through this account&apos;s proxy.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit account */}
      {editTarget && (
        <AccountFormDialog
          mode="edit"
          account={editTarget}
          open={!!editTarget}
          onOpenChange={(o) => !o && setEditTarget(null)}
        />
      )}

      {/* Resolve challenge */}
      {challengeTarget && (
        <ChallengeDialog
          account={challengeTarget}
          open={!!challengeTarget}
          onOpenChange={(o) => !o && setChallengeTarget(null)}
        />
      )}

      {/* Add account to group(s) */}
      <Dialog open={!!groupTarget} onOpenChange={(o) => !o && setGroupTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Add to group</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Select the groups for {groupTarget?.username || groupTarget?.label}.
          </p>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No groups yet. Create one on the Groups page.</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {groups.map((g) => (
                <li key={g.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 hover:bg-secondary/50">
                    <input
                      type="checkbox"
                      checked={chosenGroups.includes(g.id)}
                      onChange={() =>
                        setChosenGroups((prev) =>
                          prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id],
                        )
                      }
                      className="size-4 accent-[#d62976]"
                    />
                    <span className="text-sm">{g.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setGroupTarget(null)}>
              Cancel
            </Button>
            <Button onClick={saveGroups} disabled={savingGroups || !chosenGroups.length}>
              {savingGroups && <Loader2 className="size-4 animate-spin" />} Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// Compact relative label for the last media publish time (e.g. "3h", "2d").
// Falls back to an em dash when the account has never posted media.
function formatLastPost(value: Date | string | null | undefined): string {
  if (!value) return "—"
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return "—"
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return "just now"
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// Render a proxy as protocol://ip:port, dropping any credentials and path.
function formatProxy(type: string, url: string): string | null {
  if (!url || type === "none") return null
  let rest = url.trim()
  const schemeMatch = rest.match(/^(\w+):\/\//)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : type === "socks5" ? "socks5" : "http"
  rest = rest.replace(/^\w+:\/\//, "")
  // Strip user:pass@ credentials.
  const at = rest.lastIndexOf("@")
  if (at !== -1) rest = rest.slice(at + 1)
  // Strip any trailing path / query.
  rest = rest.split(/[/?]/)[0]
  if (!rest) return null
  return `${scheme}://${rest}`
}
