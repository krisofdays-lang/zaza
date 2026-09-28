"use client"

import { useState, useTransition } from "react"
import { setGroupMembers } from "@/app/actions/groups"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Check, Loader2, Users } from "lucide-react"
import { toast } from "sonner"

interface AccountOpt {
  id: number
  label: string
  username: string
}

export function MemberSelector({
  groupId,
  accounts,
  initialSelected,
}: {
  groupId: number
  accounts: AccountOpt[]
  initialSelected: number[]
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(initialSelected))
  const [pending, start] = useTransition()

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function save() {
    start(async () => {
      await setGroupMembers(groupId, Array.from(selected))
      toast.success("Members updated")
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4 text-muted-foreground" /> {selected.size} selected
        </p>
        <Button size="sm" variant="outline" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save members
        </Button>
      </div>
      {accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          No accounts available. Add accounts first.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {accounts.map((a) => {
            const on = selected.has(a.id)
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => toggle(a.id)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  on ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-accent"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.label}</p>
                  {a.username && <p className="truncate text-xs text-muted-foreground">@{a.username}</p>}
                </div>
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border"
                  }`}
                >
                  {on && <Check className="size-3" />}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {accounts
            .filter((a) => selected.has(a.id))
            .map((a) => (
              <Badge key={a.id} variant="secondary">
                {a.label}
              </Badge>
            ))}
        </div>
      )}
    </div>
  )
}
