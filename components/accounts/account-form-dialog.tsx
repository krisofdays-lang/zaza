"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createAccount, editAccount, getAccountSensitiveFields } from "@/app/actions/accounts"
import type { DisplayAccount } from "@/app/actions/accounts"
import { Plus, Eye, EyeOff } from "lucide-react"

const PROXY_TYPES = [
  { value: "none", label: "No proxy" },
  { value: "http", label: "HTTP / HTTPS" },
  { value: "socks5", label: "SOCKS5" },
]

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}

type FormState = {
  username: string
  password: string
  twofa: string
  cookie: string
  proxyType: string
  proxyUrl: string
  rotationUrl: string
  groupId: string
}

function initialForm(account?: DisplayAccount): FormState {
  return {
    username: account?.username ?? "",
    password: "",
    twofa: "",
    cookie: "",
    proxyType: account?.proxyType ?? "none",
    proxyUrl: account?.proxyUrl ?? "",
    rotationUrl: account?.rotationUrl ?? "",
    groupId: "none",
  }
}

export function AccountFormDialog({
  mode = "create",
  account,
  open: controlledOpen,
  onOpenChange,
  trigger,
  groups = [],
}: {
  mode?: "create" | "edit"
  account?: DisplayAccount
  open?: boolean
  onOpenChange?: (o: boolean) => void
  trigger?: React.ReactNode
  groups?: { id: number; name: string }[]
}) {
  const router = useRouter()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = (o: boolean) => {
    if (isControlled) onOpenChange?.(o)
    else setUncontrolledOpen(o)
  }

  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(() => initialForm(account))
  const [showPassword, setShowPassword] = useState(false)
  const [loadingSensitive, setLoadingSensitive] = useState(false)
  const [originalCookie, setOriginalCookie] = useState("")

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  useEffect(() => {
    if (!open || mode !== "edit" || !account) return
    setLoadingSensitive(true)
    getAccountSensitiveFields(account.id)
      .then((data) => {
        if (data) {
          setOriginalCookie(data.cookieBase64 || "")
          setForm((f) => ({
            ...f,
            password: data.password || "",
            cookie: data.cookieBase64 || "",
          }))
        }
      })
      .catch(() => {})
      .finally(() => setLoadingSensitive(false))
  }, [open, mode, account])

  function handleOpenChange(o: boolean) {
    if (o) {
      setForm(initialForm(account))
      setShowPassword(false)
    }
    setOpen(o)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.username.trim()) {
      toast.error("Username is required")
      return
    }
    if (mode === "create" && !form.cookie.trim()) {
      toast.error("Login by username/password isn't available yet — paste a base64 cookie to add this account.")
      return
    }
    setSaving(true)
    try {
      if (mode === "edit" && account) {
        const submitForm = {
          ...form,
          cookie: form.cookie === originalCookie ? "" : form.cookie,
        }
        await editAccount(account.id, submitForm)
        toast.success("Account updated")
      } else {
        const groupIds = form.groupId && form.groupId !== "none" ? [Number(form.groupId)] : []
        await createAccount({ ...form, groupIds })
        toast.success("Account added")
        setForm(initialForm())
      }
      setOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save account")
    } finally {
      setSaving(false)
    }
  }

  const isEdit = mode === "edit"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== undefined ? (
        <DialogTrigger render={trigger as React.ReactElement} />
      ) : !isControlled ? (
        <DialogTrigger
          render={
            <Button>
              <Plus className="size-4" />
              Add account
            </Button>
          }
        />
      ) : null}
      <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit account" : "Add Instagram account"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this account's credentials and proxy. Paste a new cookie only if you want to replace the stored device identity."
              : "Enter the account credentials and paste its base64 cookie. The device identity is read from the cookie; the app version is always the latest."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              required
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="account_username"
              autoComplete="off"
            />
            <Hint>The account&apos;s Instagram username. Required.</Hint>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder={loadingSensitive ? "Loading..." : "••••••••"}
                autoComplete="new-password"
                className="pr-10"
              />
              {form.password && (
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              )}
            </div>
            <Hint>Used only for the login flow when no cookie is provided.</Hint>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="twofa">2FA seed</Label>
            <Input
              id="twofa"
              value={form.twofa}
              onChange={(e) => set("twofa", e.target.value)}
              placeholder="Base32 TOTP secret (optional)"
              className="font-mono text-xs"
              autoComplete="off"
            />
            <Hint>The TOTP secret for accounts with two-factor auth. Optional.</Hint>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="cookie">Cookie (base64)</Label>
            <Textarea
              id="cookie"
              value={form.cookie}
              onChange={(e) => set("cookie", e.target.value)}
              placeholder={loadingSensitive ? "Loading..." : "eyJzYXZlZF9hdCI6..."}
              className="font-mono text-xs min-h-24"
            />
            <Hint>
              {isEdit ? (
                <>
                  Current device identity shown above. Clear the field to keep it as-is, or paste a new base64 cookie to
                  replace it.
                </>
              ) : (
                <>
                  Base64-encoded session + device snapshot. It&apos;s decoded and its device identifiers (guid,
                  family_device_id, phone_id…) are stored and reused on every request. If left blank the account would be
                  added via username/password login &mdash; <strong>not available yet</strong>.
                </>
              )}
            </Hint>
          </div>

          {!isEdit && groups.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>Group</Label>
              <Select value={form.groupId} onValueChange={(v) => set("groupId", v ?? "none")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No group</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Hint>Optionally drop this account straight into a group.</Hint>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>Proxy type</Label>
            <Select value={form.proxyType} onValueChange={(v) => set("proxyType", v ?? "")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROXY_TYPES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Hint>Route this account&apos;s requests through a proxy to keep its IP stable.</Hint>
          </div>

          {form.proxyType !== "none" && (
            <>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="proxy">Proxy URL</Label>
                <Input
                  id="proxy"
                  value={form.proxyUrl}
                  onChange={(e) => set("proxyUrl", e.target.value)}
                  placeholder={form.proxyType === "socks5" ? "socks5://user:pass@host:port" : "http://user:pass@host:port"}
                  className="font-mono text-xs"
                />
                <Hint>Full connection string including credentials, host and port.</Hint>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="rotation">Rotation link (optional)</Label>
                <Input
                  id="rotation"
                  value={form.rotationUrl}
                  onChange={(e) => set("rotationUrl", e.target.value)}
                  placeholder="https://proxy-provider/rotate?token=..."
                  className="font-mono text-xs"
                />
                <Hint>If set, a rotate button appears next to the proxy to fetch a fresh IP on demand.</Hint>
              </div>
            </>
          )}

          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? (isEdit ? "Saving..." : "Adding...") : isEdit ? "Save changes" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
