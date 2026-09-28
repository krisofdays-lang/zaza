"use client"

import { Button } from "@/components/ui/button"

// Quiet inline recovery for the (app) segment. Without this, a thrown server
// render is caught by Next.js's default overlay and shown as the red
// "An error occurred in the Server Components render" box. We never want that
// surface — a recoverable segment error should just offer a retry in place.
export default function AppSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-sm text-muted-foreground">
        This view hit a temporary error. Your data is safe — try again.
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
