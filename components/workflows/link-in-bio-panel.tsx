"use client"

import { useMemo } from "react"
import { Link as LinkIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import type { LinkInBioConfig, WfAccount } from "@/lib/workflows/types"

/**
 * Link in Bio step configuration: a column of the workflow's accounts, each with
 * its own external link URL. The step runs only for accounts with a non-empty
 * URL; blank entries are skipped (no requests fire). Links are keyed by account
 * id so the mapping survives account reordering.
 */
export function LinkInBioPanel({
  accounts,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  value: LinkInBioConfig
  onChange: (next: LinkInBioConfig) => void
}) {
  const filledCount = useMemo(
    () => accounts.filter((a) => (value.links[a.id] ?? "").trim().length > 0).length,
    [accounts, value.links],
  )

  function setLink(accountId: number, raw: string) {
    const clean = raw.trim()
    const next = { ...value.links }
    if (clean.length === 0) delete next[accountId]
    else next[accountId] = clean
    onChange({ links: next })
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <LinkIcon className="size-3.5" /> Link per account
      </p>

      {accounts.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No accounts available for this workflow yet.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {accounts.map((acc) => {
              const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
              const url = value.links[acc.id] ?? ""
              return (
                <li key={acc.id} className="space-y-2 rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                      {initial}
                    </span>
                    <span className="truncate text-sm font-medium">@{acc.username || acc.label}</span>
                  </div>
                  <Input
                    value={url}
                    onChange={(e) => setLink(acc.id, e.target.value)}
                    placeholder="https://example.com (leave empty to skip)"
                    className="text-sm"
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            {`${filledCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will get a link. Blank URLs are skipped.`}
          </p>
        </>
      )}
    </div>
  )
}
