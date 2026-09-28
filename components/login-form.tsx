"use client"

import { useActionState } from "react"
import { useFormStatus } from "react-dom"
import { Loader2 } from "lucide-react"
import { loginAction } from "@/app/actions/auth"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="w-full ig-gradient text-white">
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      {pending ? "Verifying…" : "Login"}
    </Button>
  )
}

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, {})

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="licenseKey" className="text-xs font-medium text-muted-foreground">
          License Key
        </Label>
        <Input
          id="licenseKey"
          name="licenseKey"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
          className="font-mono tracking-tight"
          aria-invalid={state?.error ? true : undefined}
        />
        {state?.error ? (
          <p className="text-xs text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
      <SubmitButton />
    </form>
  )
}
