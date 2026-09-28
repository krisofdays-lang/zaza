"use client"

import { useMemo } from "react"
import { AtSign } from "lucide-react"
import { Input } from "@/components/ui/input"
import type { UsernameChangeConfig, WfAccount } from "@/lib/workflows/types"

// Instagram usernames allow lowercase letters, digits, periods and underscores.
function sanitizeUsername(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 30)
}

/**
 * Username Change step configuration: a column of the workflow's accounts, each
 * with its own new-username input. The step runs only for accounts with a
 * non-empty username; blank entries are skipped (no requests fire). Usernames
 * are keyed by account id so the mapping survives account reordering.
 */
export function UsernameChangePanel({
  accounts,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  value: UsernameChangeConfig
  onChange: (next: UsernameChangeConfig) => void
}) {
  const filledCount = useMemo(
    () => accounts.filter((a) => (value.usernames[a.id] ?? "").trim().length > 0).length,
    [accounts, value.usernames],
  )

  function setUsername(accountId: number, raw: string) {
    const clean = sanitizeUsername(raw)
    const next = { ...value.usernames }
    if (clean.length === 0) delete next[accountId]
    else next[accountId] = clean
    onChange({ usernames: next })
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <AtSign className="size-3.5" /> Username per account
      </p>

      {accounts.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No accounts available for this workflow yet.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {accounts.map((acc) => {
              const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
              const username = value.usernames[acc.id] ?? ""
              return (
                <li key={acc.id} className="space-y-2 rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                      {initial}
                    </span>
                    <span className="truncate text-sm font-medium">@{acc.username || acc.label}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {username.length}/30
                    </span>
                  </div>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      @
                    </span>
                    <Input
                      value={username}
                      onChange={(e) => setUsername(acc.id, e.target.value)}
                      placeholder="new_username (leave empty to skip)"
                      className="pl-7 text-sm"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            {`${filledCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will be updated. Blank usernames are skipped.`}
          </p>
        </>
      )}
    </div>
  )
}
