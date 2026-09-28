"use client"

import { Heart, Repeat2, Bookmark, UserPlus, Clock } from "lucide-react"
import { Input } from "@/components/ui/input"
import { DURATION_PRESETS, type WarmupConfig } from "@/lib/warmup/types"

const ACTION_ROWS: { key: keyof Omit<WarmupConfig, "durationMin">; label: string; icon: typeof Heart; color: string }[] = [
  { key: "like", label: "Like", icon: Heart, color: "#ed4956" },
  { key: "repost", label: "Repost", icon: Repeat2, color: "#3897f0" },
  { key: "save", label: "Save", icon: Bookmark, color: "#fa7e1e" },
  { key: "follow", label: "Follow", icon: UserPlus, color: "#4f5bd5" },
]

// Shared knobs for a warm-up session: per-action chance sliders + duration.
// Used both in the Warm up section and in the workflow Feed Scrolling node editor.
export function WarmupKnobs({
  config,
  onChange,
  compact = false,
}: {
  config: WarmupConfig
  onChange: (next: WarmupConfig) => void
  compact?: boolean
}) {
  const set = (patch: Partial<WarmupConfig>) => onChange({ ...config, ...patch })

  return (
    <div className="flex flex-col gap-4">
      {/* Action chance sliders */}
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Action chance</p>
        {ACTION_ROWS.map((row) => {
          const Icon = row.icon
          const value = config[row.key] ?? 0
          return (
            <div key={row.key} className="grid grid-cols-[88px_minmax(0,1fr)_44px] items-center gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4" style={{ color: row.color }} />
                {row.label}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={value}
                onChange={(e) => set({ [row.key]: Number(e.target.value) } as Partial<WarmupConfig>)}
                className="w-full accent-[#d62976]"
                style={{ accentColor: row.color }}
                aria-label={`${row.label} chance`}
              />
              <span className="text-right text-sm tabular-nums text-muted-foreground">{value}%</span>
            </div>
          )
        })}
      </div>

      {/* Duration */}
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Clock className="size-3.5" /> Duration
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {DURATION_PRESETS.map((preset) => {
            const active = config.durationMin === preset
            return (
              <button
                key={preset}
                type="button"
                onClick={() => set({ durationMin: preset })}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "border-transparent text-primary-foreground ig-gradient"
                    : "border-border bg-card text-foreground hover:bg-secondary/50"
                }`}
              >
                {preset} min
              </button>
            )
          })}
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              max={240}
              value={config.durationMin}
              onChange={(e) => set({ durationMin: Math.max(1, Number(e.target.value) || 1) })}
              className={`h-9 w-20 ${compact ? "text-sm" : ""}`}
              aria-label="Custom duration in minutes"
            />
            <span className="text-sm text-muted-foreground">min</span>
          </div>
        </div>
      </div>
    </div>
  )
}
