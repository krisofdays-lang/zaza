"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Copy, Plus, Trash2, ShieldCheck } from "lucide-react"
import { createLicense, revokeLicense, type LicenseRow } from "@/app/actions/admin"

export function AdminLicenses({ initial, currentUserId }: { initial: LicenseRow[]; currentUserId: number }) {
  const [rows, setRows] = useState<LicenseRow[]>(initial)
  const [label, setLabel] = useState("")
  const [isPending, startTransition] = useTransition()

  function handleCreate() {
    startTransition(async () => {
      const res = await createLicense(label)
      if (!res.ok || !res.licenseKey) {
        toast.error(res.error ?? "Could not create license.")
        return
      }
      await navigator.clipboard?.writeText(res.licenseKey).catch(() => {})
      toast.success("License created and copied to clipboard.")
      setLabel("")
      // Optimistically prepend; the row count will fill in on next load.
      setRows((prev) => [
        {
          id: -Date.now(),
          licenseKey: res.licenseKey!,
          label: label.trim(),
          isAdmin: false,
          createdAt: new Date().toISOString(),
          accounts: 0,
          workflows: 0,
          groups: 0,
        },
        ...prev,
      ])
    })
  }

  function handleRevoke(id: number, key: string) {
    if (!confirm(`Revoke this license? All data for ${key.slice(0, 8)}… will be permanently deleted.`)) return
    startTransition(async () => {
      const res = await revokeLicense(id)
      if (!res.ok) {
        toast.error(res.error ?? "Could not revoke.")
        return
      }
      toast.success("License revoked.")
      setRows((prev) => prev.filter((r) => r.id !== id))
    })
  }

  function copyKey(key: string) {
    navigator.clipboard?.writeText(key).then(
      () => toast.success("Copied."),
      () => toast.error("Copy failed."),
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card className="p-4 md:p-5">
        <h2 className="text-sm font-semibold">Create a license</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Generates a new key. Share it with the user — they log in with it, and everything they create stays scoped to
          that key.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Client name)"
            className="sm:max-w-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) handleCreate()
            }}
          />
          <Button onClick={handleCreate} disabled={isPending} className="ig-gradient text-white">
            <Plus className="size-4" />
            Generate key
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>License key</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="text-right">Accounts</TableHead>
              <TableHead className="text-right">Workflows</TableHead>
              <TableHead className="text-right">Groups</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No licenses yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => {
              const isSelf = row.id === currentUserId
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span className="truncate max-w-[14rem]">{row.licenseKey}</span>
                      <button
                        type="button"
                        onClick={() => copyKey(row.licenseKey)}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="Copy license key"
                        title="Copy"
                      >
                        <Copy className="size-3.5" />
                      </button>
                      {row.isAdmin && (
                        <Badge variant="secondary" className="gap-1">
                          <ShieldCheck className="size-3" />
                          Owner
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{row.label || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.accounts}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.workflows}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.groups}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending || isSelf || row.isAdmin}
                      onClick={() => handleRevoke(row.id, row.licenseKey)}
                      className="text-muted-foreground hover:text-destructive"
                      title={isSelf ? "You cannot revoke your own license" : "Revoke license"}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
