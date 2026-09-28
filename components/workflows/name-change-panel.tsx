"use client"

import { useMemo } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { User, Wand2 } from "lucide-react"
import { type NameChangeConfig, randomFemaleName, type WfAccount } from "@/lib/workflows/types"

/**
 * Name Change step configuration: a column of the workflow's accounts, each with
 * a field for the new display name. A single global autofill button fills every
 * field with a random US female name. Accounts with a blank field are skipped.
 */
export function NameChangePanel({
  accounts,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  value: NameChangeConfig
  onChange: (next: NameChangeConfig) => void
}) {
  const filledCount = useMemo(
    () => accounts.filter((a) => (value.names[a.id] ?? "").trim().length > 0).length,
    [accounts, value.names],
  )

  function setName(accountId: number, name: string) {
    onChange({ names: { ...value.names, [accountId]: name } })
  }

  // Fill every account's field with a distinct random US female name.
  function autofillAll() {
    const used = new Set<string>()
    const names: Record<number, string> = {}
    for (const acc of accounts) {
      const name = randomFemaleName(used)
      used.add(name)
      names[acc.id] = name
    }
    onChange({ names })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <User className="size-3.5" /> Name per account
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={accounts.length === 0}
          onClick={autofillAll}
          title="Fill all fields with random US female names"
        >
          <Wand2 className="size-3" /> Autofill
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-center text-xs text-muted-foreground">
          No accounts available yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((acc) => {
            const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
            return (
              <li
                key={acc.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {initial}
                </span>
                <span className="w-24 shrink-0 truncate text-sm font-medium">@{acc.username || acc.label}</span>
                <Input
                  value={value.names[acc.id] ?? ""}
                  onChange={(e) => setName(acc.id, e.target.value)}
                  placeholder="New name…"
                  className="h-8 flex-1 text-sm"
                />
              </li>
            )
          })}
        </ul>
      )}

      {accounts.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {`${filledCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will be updated. Blank fields are skipped.`}
        </p>
      )}
    </div>
  )
}
