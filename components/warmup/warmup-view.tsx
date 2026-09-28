"use client"

import { useState } from "react"
import { Newspaper, Clapperboard, GraduationCap, CircleUserRound } from "lucide-react"
import { FeedScrollPanel } from "@/components/warmup/feed-scroll-panel"
import { WarmupQueue } from "@/components/warmup/warmup-queue"
import type { WarmupJobStatus, WarmupKind } from "@/lib/warmup/types"
import type { DisplayAccount } from "@/app/actions/accounts"

type GroupLite = { id: number; name: string; accountIds: number[] }

const TABS: { id: WarmupKind; label: string; icon: typeof Newspaper; ready: boolean }[] = [
  { id: "feed_scroll", label: "Feed Scroll", icon: Newspaper, ready: true },
  { id: "reels_scroll", label: "Reels Scroll", icon: Clapperboard, ready: true },
  { id: "feed_training", label: "Feed Training", icon: GraduationCap, ready: false },
  { id: "stories_tracker", label: "Stories Tracker", icon: CircleUserRound, ready: false },
]

export function WarmupView({
  accounts,
  groups,
  initialJobs,
}: {
  accounts: DisplayAccount[]
  groups: GroupLite[]
  initialJobs: WarmupJobStatus[]
}) {
  const [tab, setTab] = useState<WarmupKind>("feed_scroll")
  const [refreshSignal, setRefreshSignal] = useState(0)

  const refreshJobs = () => setRefreshSignal((n) => n + 1)

  return (
    <div className="flex flex-col gap-5 px-6 pb-10">
      {/* Subsection tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "border-transparent text-primary-foreground ig-gradient"
                  : "border-border bg-card text-foreground hover:bg-secondary/50"
              }`}
            >
              <Icon className="size-4" />
              {t.label}
              {!t.ready && <span className="text-[10px] opacity-70">(soon)</span>}
            </button>
          )
        })}
      </div>

      {tab === "feed_scroll" || tab === "reels_scroll" ? (
        <FeedScrollPanel accounts={accounts} groups={groups} kind={tab} onStarted={refreshJobs} />
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <p className="text-sm font-medium">{TABS.find((t) => t.id === tab)?.label} is coming next</p>
          <p className="max-w-md text-sm text-muted-foreground">
            We started with Feed Scroll. This subsection will reuse the same account selection, chance sliders, and queue
            once its endpoints are wired up.
          </p>
        </div>
      )}

      <WarmupQueue initial={initialJobs} refreshSignal={refreshSignal} />
    </div>
  )
}
