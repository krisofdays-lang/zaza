import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function StatCard({
  label,
  value,
  icon: Icon,
  chipClass,
  dim,
}: {
  label: string
  value: number
  icon: LucideIcon
  // Tailwind/utility classes for the icon chip background (an Instagram-tone color).
  chipClass: string
  // Dim the value when it represents an empty/neutral count (e.g. 0 flagged).
  dim?: boolean
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card p-5 velvet-card velvet-surface transition-all duration-300 hover:-translate-y-0.5">
      {/* faint gradient wash that brightens on hover */}
      <div className="pointer-events-none absolute -right-8 -top-8 size-28 rounded-full ig-gradient opacity-[0.06] blur-2xl transition-opacity duration-300 group-hover:opacity-15" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p
            className={cn(
              "mt-2 text-3xl font-semibold tabular-nums",
              dim ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {value}
          </p>
        </div>
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl text-white shadow-sm", chipClass)}>
          <Icon className="size-5" />
        </span>
      </div>
    </div>
  )
}
