import type React from "react"

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground mt-0.5 text-pretty">{description}</p> : null}
      </div>
      {children ? <div className="flex items-center gap-2 shrink-0">{children}</div> : null}
    </header>
  )
}
