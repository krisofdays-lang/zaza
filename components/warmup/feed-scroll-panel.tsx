"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Search, Loader2, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WarmupKnobs } from "@/components/warmup/warmup-knobs"
import { ConcurrencyControl, clampConcurrency } from "@/components/shared/concurrency-control"
import { startWarmup } from "@/app/actions/warmup"
import { DEFAULT_WARMUP_CONFIG, type WarmupConfig, type WarmupKind } from "@/lib/warmup/types"
import type { DisplayAccount } from "@/app/actions/accounts"

type GroupLite = { id: number; name: string; accountIds: number[] }

export function FeedScrollPanel({
  accounts,
  groups,
  kind = "feed_scroll",
  onStarted,
}: {
  accounts: DisplayAccount[]
  groups: GroupLite[]
  kind?: WarmupKind
  onStarted?: () => void
}) {
  const [search, setSearch] = useState("")
  const [groupId, setGroupId] = useState<number | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [config, setConfig] = useState<WarmupConfig>(DEFAULT_WARMUP_CONFIG)
  const [concurrency, setConcurrency] = useState(1)
  const [starting, setStarting] = useState(false)

  const handleOf = (a: DisplayAccount) => a.username || a.label || `Account ${a.id}`

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts.filter((a) => (q ? handleOf(a).toLowerCase().includes(q) : true))
  }, [accounts, search])

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function applyGroup(id: number | null) {
    setGroupId(id)
    if (id == null) {
      setSelected([])
      return
    }
    const g = groups.find((x) => x.id === id)
    if (g) setSelected(g.accountIds)
  }

  const allVisibleSelected = filtered.length > 0 && filtered.every((a) => selected.includes(a.id))
  function toggleAll() {
    if (allVisibleSelected) {
      const ids = new Set(filtered.map((a) => a.id))
      setSelected((prev) => prev.filter((x) => !ids.has(x)))
    } else {
      setSelected((prev) => Array.from(new Set([...prev, ...filtered.map((a) => a.id)])))
    }
  }

  async function handleStart() {
    if (selected.length === 0) return toast.error("Select at least one account")
    setStarting(true)
    const res = await startWarmup({
      kind,
      accountIds: selected,
      groupId,
      config,
      concurrency: clampConcurrency(concurrency, selected.length),
    })
    setStarting(false)
    if (!res.ok) return toast.error(res.error || "Failed to start")
    toast.success(`Warm-up started for ${selected.length} account(s)`)
    onStarted?.()
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* Account selection */}
      <section className="rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="ig-gradient-text">Select Accounts</span>
            <span className="text-muted-foreground">({selected.length} selected)</span>
            {selected.length > 0 && (
              <button onClick={() => { setSelected([]); setGroupId(null) }} className="text-xs text-primary">
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search username..."
                className="h-9 w-48 pl-8"
              />
            </div>
            <select
              value={groupId ?? ""}
              onChange={(e) => applyGroup(e.target.value ? Number(e.target.value) : null)}
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="">Group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="flex items-center gap-3 border-b border-border px-4 py-2">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleAll}
            className="size-4 accent-[#d62976]"
            aria-label="Select all"
          />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Select all ({filtered.length})
          </span>
        </div>

        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No accounts found</li>
          )}
          {filtered.map((a) => {
            const checked = selected.includes(a.id)
            const profile = (a.profile ?? {}) as { profile_pic_url?: string }
            const group = groups.find((g) => g.accountIds.includes(a.id))
            return (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(a.id)}
                  className="size-4 accent-[#d62976]"
                />
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <div className="shrink-0 rounded-full bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] p-[1.5px]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={profile.profile_pic_url || "/placeholder.svg"}
                      alt=""
                      crossOrigin="anonymous"
                      className="size-7 rounded-full border border-card object-cover"
                    />
                  </div>
                  <span className="truncate text-sm font-medium">@{handleOf(a)}</span>
                </div>
                <span className="hidden truncate text-xs text-muted-foreground sm:block">{group?.name ?? "—"}</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                  {a.status}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      {/* Knobs + start */}
      <section className="flex h-fit flex-col gap-4 rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Session settings</h3>
        <WarmupKnobs config={config} onChange={setConfig} />
        {selected.length > 1 && (
          <ConcurrencyControl value={concurrency} onChange={setConcurrency} accountCount={selected.length} />
        )}
        <p className="text-xs text-muted-foreground">
          {`Each account scrolls its ${kind === "reels_scroll" ? "reels feed" : "home feed"} for the chosen duration, pausing to "watch" ${kind === "reels_scroll" ? "reels" : "posts"} and rolling the dice on every one to like, repost, save, or follow.`}
        </p>
        <Button
          onClick={handleStart}
          disabled={starting || selected.length === 0}
          className="ig-gradient text-primary-foreground"
        >
          {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          Start warm-up{selected.length > 0 ? ` (${selected.length})` : ""}
        </Button>
      </section>
    </div>
  )
}
