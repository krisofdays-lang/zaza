import { cn } from "@/lib/utils"

const MAP: Record<string, { label: string; dot: string; text: string }> = {
  ok: { label: "Healthy", dot: "bg-primary", text: "text-primary" },
  idle: { label: "Idle", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  running: { label: "Running", dot: "bg-chart-3 animate-pulse", text: "text-chart-3" },
  error: { label: "Error", dot: "bg-destructive", text: "text-destructive" },
  // Distinct Instagram account states classified from the API response so the
  // operator can tell a logout apart from a challenge apart from an action block.
  checkpoint: { label: "Challenge", dot: "bg-chart-4", text: "text-chart-4" },
  feedback_required: { label: "Action blocked", dot: "bg-chart-4", text: "text-chart-4" },
  login_required: { label: "Logged out", dot: "bg-destructive", text: "text-destructive" },
  consent_required: { label: "Consent gate", dot: "bg-chart-4", text: "text-chart-4" },
  not_found: { label: "Not found", dot: "bg-muted-foreground", text: "text-muted-foreground" },
}

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  const s = MAP[status] ?? MAP.idle
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium"
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      <span className={s.text}>{s.label}</span>
    </span>
  )
}
