"use client"

import { useMemo } from "react"
import { Pencil } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import type { BioChangeConfig, WfAccount } from "@/lib/workflows/types"

/**
 * Biography Change step configuration: a column of the workflow's accounts, each
 * with its own bio textarea. The step runs for every account that has non-empty
 * bio text; accounts left blank are skipped. Bios are keyed by account id so the
 * mapping survives account reordering.
 */
export function BioChangePanel({
  accounts,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  value: BioChangeConfig
  onChange: (next: BioChangeConfig) => void
}) {
  const filledCount = useMemo(
    () => accounts.filter((a) => (value.bios[a.id] ?? "").trim().length > 0).length,
    [accounts, value.bios],
  )

  function setBio(accountId: number, text: string) {
    const next = { ...value.bios }
    if (text.length === 0) delete next[accountId]
    else next[accountId] = text
    onChange({ bios: next })
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Pencil className="size-3.5" /> Biography per account
      </p>

      {accounts.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No accounts available for this workflow yet.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {accounts.map((acc) => {
              const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
              const bio = value.bios[acc.id] ?? ""
              return (
                <li key={acc.id} className="space-y-2 rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                      {initial}
                    </span>
                    <span className="truncate text-sm font-medium">@{acc.username || acc.label}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {bio.length}/150
                    </span>
                  </div>
                  <Textarea
                    value={bio}
                    onChange={(e) => setBio(acc.id, e.target.value.slice(0, 150))}
                    placeholder="New bio (leave empty to skip this account)"
                    rows={3}
                    className="resize-none text-sm"
                  />
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            {`${filledCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will be updated. Blank bios are skipped.`}
          </p>
        </>
      )}
    </div>
  )
}
