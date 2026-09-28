"use client"

import type React from "react"
import { usePathname } from "next/navigation"

// Re-mounts its children whenever the route changes (keyed by pathname) so the
// CSS entrance animation replays on every section switch.
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div key={pathname} className="animate-section-in">
      {children}
    </div>
  )
}
