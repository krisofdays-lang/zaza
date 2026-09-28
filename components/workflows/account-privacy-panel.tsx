"use client"

import { useMemo } from "react"
import { ShieldCheck } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import type { AccountPrivacyConfig, WfAccount } from "@/lib/workflows/types"

/**
 * Account Privacy step configuration: a column of the workflow's accounts, each
 * with a toggle. ON = set the account private, OFF = set it public. Every listed
 * account is processed (no skipping). Toggles default ON, so we store only the
 * ids switched to public; newly added accounts default to private.
 */
export function AccountPrivacyPanel({
  accounts,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  value: AccountPrivacyConfig
  onChange: (next: AccountPrivacyConfig) => void
}) {
  const publicIds = useMemo(() => new Set(value.publicAccountIds), [value.publicAccountIds])
  const privateCount = accounts.length - accounts.filter((a) => publicIds.has(a.id)).length

  function setPrivate(accountId: number, isPrivate: boolean) {
    const next = new Set(publicIds)
    if (isPrivate) next.delete(accountId)
    else next.add(accountId)
    onChange({ publicAccountIds: [...next] })
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <ShieldCheck className="size-3.5" /> Accounts
      </p>

      {accounts.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No accounts available for this workflow yet.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {accounts.map((acc) => {
              const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
              const isPrivate = !publicIds.has(acc.id)
              return (
                <li
                  key={acc.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {initial}
                  </span>
                  <span className="truncate text-sm font-medium">@{acc.username || acc.label}</span>
                  <span className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground">
                    {isPrivate ? "Private" : "Public"}
                  </span>
                  <Switch
                    className="shrink-0"
                    checked={isPrivate}
                    onCheckedChange={(checked) => setPrivate(acc.id, checked)}
                    aria-label={`Set ${acc.username || acc.label} ${isPrivate ? "public" : "private"}`}
                  />
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            {`${privateCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} set to private, the rest public.`}
          </p>
        </>
      )}
    </div>
  )
}
