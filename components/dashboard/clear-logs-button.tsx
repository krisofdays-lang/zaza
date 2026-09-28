"use client"

import { useState } from "react"
import { Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { clearLogs } from "@/app/actions/accounts"

// Small icon button shown in the Recent Jobs header that wipes the run log
// history after a confirmation.
export function ClearLogsButton() {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function onConfirm() {
    setPending(true)
    try {
      const res = await clearLogs()
      if (res.ok) {
        toast.success("Logs cleared")
        setOpen(false)
      } else {
        toast.error("Could not clear logs")
      }
    } catch {
      toast.error("Could not clear logs")
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Clear logs"
        title="Clear logs"
        onClick={() => setOpen(true)}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </button>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear logs?</DialogTitle>
            <DialogDescription>
              This permanently removes all recent job history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirm} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
