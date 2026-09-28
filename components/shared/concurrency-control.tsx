"use client"

import { useMemo } from "react"
import { Slider } from "@/components/ui/slider"
import { Users, GitBranch, ArrowDownUp } from "lucide-react"
import { cn } from "@/lib/utils"

const HARD_MAX = 20

export function clampConcurrency(value: number, accountCount: number): number {
  const max = Math.max(1, Math.min(HARD_MAX, accountCount || 1))
  return Math.max(1, Math.min(max, Math.round(value) || 1))
}

/**
 * Lets the user pick how many accounts run at once. 1 = strictly sequential,
 * >1 = parallel. The maximum is capped at min(20, number of selected accounts)
 * so the user can never request more parallelism than they have accounts.
 */
export function ConcurrencyControl({
  value,
  onChange,
  accountCount,
  className,
}: {
  value: number
  onChange: (next: number) => void
  accountCount: number
  className?: string
}) {
  const max = useMemo(() => Math.max(1, Math.min(HARD_MAX, accountCount || 1)), [accountCount])
  const current = clampConcurrency(value, accountCount)
  const sequential = current <= 1
  const disabled = max <= 1

  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {sequential ? (
            <ArrowDownUp className="size-4 text-muted-foreground" />
          ) : (
            <GitBranch className="size-4 text-[#d62976]" />
          )}
          <div>
            <p className="text-sm font-medium">{sequential ? "Sequential" : "Parallel"}</p>
            <p className="text-xs text-muted-foreground">
              {sequential
                ? "Accounts run one after another"
                : `Up to ${current} accounts run at the same time`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1.5">
          <Users className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-semibold tabular-nums">
            {current}
            <span className="text-muted-foreground">/{max}</span>
          </span>
        </div>
      </div>

      <Slider
        className="mt-4"
        min={1}
        max={max}
        step={1}
        value={[current]}
        disabled={disabled}
        onValueChange={(v) => {
          const next = Array.isArray(v) ? v[0] : v
          onChange(clampConcurrency(next ?? 1, accountCount))
        }}
        aria-label="Parallel accounts"
      />
      <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
        <span>1 · sequential</span>
        <span>
          {max} · {max === 1 ? "max" : "parallel"}
        </span>
      </div>
      {disabled && (
        <p className="mt-2 text-[11px] text-muted-foreground">Select more accounts to enable parallel runs.</p>
      )}
    </div>
  )
}
