import { Activity, History, CheckCircle2, XCircle, Loader2, Workflow, Flame, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import { ClearLogsButton } from "@/components/dashboard/clear-logs-button"

export type ActiveJob = {
  id: string
  kind: "workflow" | "warmup" | "publication"
  title: string
  subtitle: string
  status: string // queued | running
  processed: number
  total: number
}
export type RecentJob = {
  id: number
  username: string
  action: string
  status: string // ok | error | pending
  message: string
  when: Date
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function PanelShell({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string
  icon: typeof Activity
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="flex h-full flex-col rounded-2xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="ig-gradient-text">
          <Icon className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </section>
  )
}

const KIND_ICON: Record<ActiveJob["kind"], typeof Activity> = {
  workflow: Workflow,
  warmup: Flame,
  publication: Send,
}

export function ActiveJobsPanel({ jobs }: { jobs: ActiveJob[] }) {
  return (
    <PanelShell title="Active Jobs" icon={Activity}>
      {jobs.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-muted-foreground">No queues are running right now.</p>
      ) : (
        <ul className="space-y-1">
          {jobs.map((j) => {
            const KindIcon = KIND_ICON[j.kind]
            const queued = j.status === "queued"
            return (
              <li
                key={j.id}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary/50"
              >
                <span className="relative flex size-2 shrink-0">
                  {!queued && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#d62976] opacity-75" />
                  )}
                  <span
                    className={cn(
                      "relative inline-flex size-2 rounded-full",
                      queued ? "bg-muted-foreground" : "bg-[#d62976]",
                    )}
                  />
                </span>
                <KindIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{j.title}</div>
                  <p className="truncate text-xs text-muted-foreground">{j.subtitle}</p>
                </div>
                {j.total > 0 && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {j.processed}/{j.total}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </PanelShell>
  )
}

export function RecentJobsPanel({ jobs }: { jobs: RecentJob[] }) {
  return (
    <PanelShell title="Accounts Activity" icon={History} action={jobs.length > 0 ? <ClearLogsButton /> : null}>
      {jobs.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-muted-foreground">No activity logged yet.</p>
      ) : (
        <ul className="space-y-1">
          {jobs.map((j) => {
            const StatusIcon = j.status === "ok" ? CheckCircle2 : j.status === "error" ? XCircle : Loader2
            const statusColor =
              j.status === "ok" ? "text-emerald-400" : j.status === "error" ? "text-destructive" : "text-[#fa7e1e]"
            return (
              <li
                key={j.id}
                className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary/50"
              >
                <StatusIcon className={cn("mt-0.5 size-4 shrink-0", statusColor, j.status === "pending" && "animate-spin")} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{j.username}</span>
                    <span className="truncate text-xs text-muted-foreground">{j.action}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{j.message}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(j.when)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </PanelShell>
  )
}
