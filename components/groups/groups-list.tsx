"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createGroup, deleteGroup } from "@/app/actions/groups"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Plus, Users, Trash2, ChevronRight, Check, Loader2 } from "lucide-react"
import { toast } from "sonner"

interface GroupRow {
  id: number
  name: string
  description: string
  accountIds: number[]
}

interface AccountOpt {
  id: number
  label: string
  username: string
}

export function GroupsList({ groups, accounts }: { groups: GroupRow[]; accounts: AccountOpt[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [creating, setCreating] = useState(false)
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set())

  function togglePick(id: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function create() {
    if (!name.trim()) {
      toast.error("Group name is required")
      return
    }
    setCreating(true)
    try {
      await createGroup(name.trim(), description.trim(), Array.from(picked))
      toast.success("Group created")
      setOpen(false)
      setName("")
      setDescription("")
      setPicked(new Set())
      router.refresh()
    } catch {
      toast.error("Failed to create group")
    } finally {
      setCreating(false)
    }
  }

  function remove(id: number) {
    setRemovedIds((s) => new Set(s).add(id))
    toast.success("Group deleted")
    deleteGroup(id) // fire and forget
  }

  const visibleGroups = groups.filter((g) => !removedIds.has(g.id))

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus className="size-4" /> New group
              </Button>
            }
          />
          <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Create group</DialogTitle>
              <DialogDescription>Name the group and pick the accounts that belong to it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="g-name">Name</Label>
                <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Warmup batch A" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="g-desc">Description</Label>
                <Textarea id="g-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes about this group" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Accounts</Label>
                  <span className="text-xs text-muted-foreground">{picked.size} selected</span>
                </div>
                {accounts.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                    No accounts yet. Add accounts first.
                  </p>
                ) : (
                  <div className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                    {accounts.map((a) => {
                      const on = picked.has(a.id)
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => togglePick(a.id)}
                          className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
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
              </div>
            </div>
            <DialogFooter>
              <Button onClick={create} disabled={creating}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : null}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
          <Users className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No groups yet. Create one and assign accounts to it.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleGroups.map((g) => (
            <div key={g.id} className="group relative flex flex-col rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/groups/${g.id}`} className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold">{g.name}</h3>
                  {g.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{g.description}</p>}
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(g.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <Users className="size-3" /> {g.accountIds.length} account{g.accountIds.length === 1 ? "" : "s"}
                </Badge>
              </div>
              <Link
                href={`/groups/${g.id}`}
                className="mt-4 flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Manage accounts
                <ChevronRight className="size-4" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
