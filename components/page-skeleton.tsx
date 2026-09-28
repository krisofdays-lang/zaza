// Lightweight shimmer skeleton shown during route transitions (loading.tsx).
// Keeps the page header visible and renders placeholder blocks for the content
// area so navigation feels instant instead of hanging.

export function PageSkeleton({
  title,
  description,
  cards = 0,
  rows = 5,
}: {
  title: string
  description?: string
  cards?: number
  rows?: number
}) {
  return (
    <div className="flex flex-col animate-in fade-in duration-150">
      <header className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground mt-0.5">{description}</p> : null}
        </div>
        <div className="h-9 w-32 rounded-lg bg-secondary/60 animate-pulse" />
      </header>

      <div className="space-y-6 px-6 py-5">
        {/* Stat cards */}
        {cards > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: cards }).map((_, i) => (
              <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        )}

        {/* Table rows */}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="h-10 border-b border-border bg-secondary/40" />
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
              <div className="size-10 shrink-0 rounded-full bg-secondary/60 animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-32 rounded bg-secondary/60 animate-pulse" />
                <div className="h-3 w-20 rounded bg-secondary/40 animate-pulse" />
              </div>
              <div className="hidden md:block h-4 w-12 rounded bg-secondary/40 animate-pulse" />
              <div className="hidden md:block h-4 w-16 rounded bg-secondary/40 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function GridSkeleton({
  title,
  description,
  count = 6,
}: {
  title: string
  description?: string
  count?: number
}) {
  return (
    <div className="flex flex-col animate-in fade-in duration-150">
      <header className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground mt-0.5">{description}</p> : null}
        </div>
        <div className="h-9 w-32 rounded-lg bg-secondary/60 animate-pulse" />
      </header>
      <div className="px-6 py-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="h-40 rounded-xl border border-border bg-card animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function MediaSkeleton({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col animate-in fade-in duration-150">
      <header className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground mt-0.5">{description}</p> : null}
        </div>
      </header>
      <div className="px-6 pb-10 pt-2 space-y-5">
        <div className="h-32 rounded-xl border border-dashed border-border bg-card/50 animate-pulse" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="aspect-square bg-secondary/40 animate-pulse" />
              <div className="space-y-2 p-2.5">
                <div className="h-3 w-20 rounded bg-secondary/60 animate-pulse" />
                <div className="h-7 rounded bg-secondary/40 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
