"use client"

import { useMemo, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Trophy, Eye, Heart } from "lucide-react"
import type { AccountAnalytics } from "@/app/actions/analytics"
import { formatCompact } from "./reel-card"
import { cn } from "@/lib/utils"

type Metric = "views" | "likes"

export function TopAccounts({ accounts }: { accounts: AccountAnalytics[] }) {
  const [metric, setMetric] = useState<Metric>("views")

  const ranked = useMemo(() => {
    return [...accounts].sort((a, b) => b[metric] - a[metric]).slice(0, 10)
  }, [accounts, metric])

  const max = ranked.length ? ranked[0][metric] : 0

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Trophy className="size-4 text-[#feda75]" />
          Top accounts
        </h2>
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {(["views", "likes"] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                metric === m ? "ig-gradient text-white shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {ranked.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No reel data yet.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-2">
          {ranked.map((a, i) => {
            const value = a[metric]
            const pct = max > 0 ? Math.max(4, (value / max) * 100) : 0
            const rank = i + 1
            return (
              <li
                key={a.id}
                className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-secondary/40 p-2.5"
              >
                {/* relative-fill bar behind the row */}
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 ig-gradient opacity-[0.08]"
                  style={{ width: `${pct}%` }}
                />
                <span
                  className={cn(
                    "z-10 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    rank === 1
                      ? "bg-[#feda75] text-black"
                      : rank === 2
                        ? "bg-[#d62976] text-white"
                        : rank === 3
                          ? "bg-[#962fbf] text-white"
                          : "bg-muted text-muted-foreground",
                  )}
                >
                  {rank}
                </span>
                <Avatar className="z-10 size-9 border border-border">
                  <AvatarImage src={a.avatar || "/placeholder.svg"} alt={a.username} referrerPolicy="no-referrer" />
                  <AvatarFallback className="bg-secondary text-xs">{a.username.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="z-10 min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">@{a.username}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.reels} reels · {a.engagementRate.toFixed(2)}% eng.
                  </p>
                </div>
                <div className="z-10 flex shrink-0 items-center gap-1 text-sm font-semibold tabular-nums">
                  {metric === "views" ? <Eye className="size-3.5 text-muted-foreground" /> : <Heart className="size-3.5 text-muted-foreground" />}
                  {formatCompact(value)}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
