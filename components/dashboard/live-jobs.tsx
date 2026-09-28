"use client"

import { useEffect, useRef, useState } from "react"
import { getDashboardActivity, type DashboardActivity } from "@/app/actions/accounts"
import {
  ActiveJobsPanel,
  RecentJobsPanel,
  type ActiveJob,
  type RecentJob,
} from "@/components/dashboard/jobs-panel"

// How often the dashboard refreshes its Active/Recent Jobs without a full page
// reload. Light enough for the DB, fast enough to feel live while a run is on.
const POLL_MS = 2500

function toRecent(rows: DashboardActivity["recentJobs"]): RecentJob[] {
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    action: r.action,
    status: r.status,
    message: r.message,
    when: new Date(r.whenISO),
  }))
}

export function LiveJobs({ initial }: { initial: DashboardActivity }) {
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>(initial.activeJobs)
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>(() => toRecent(initial.recentJobs))
  // Pause polling while the tab is hidden to avoid pointless background work.
  const hiddenRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      if (!hiddenRef.current) {
        try {
          const data = await getDashboardActivity()
          if (!cancelled) {
            setActiveJobs(data.activeJobs)
            setRecentJobs(toRecent(data.recentJobs))
          }
        } catch {
          // ignore transient errors; keep showing the last good data
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }

    const onVisibility = () => {
      hiddenRef.current = document.visibilityState === "hidden"
    }
    document.addEventListener("visibilitychange", onVisibility)
    timer = setTimeout(tick, POLL_MS)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="h-72">
        <ActiveJobsPanel jobs={activeJobs} />
      </div>
      <div className="h-72">
        <RecentJobsPanel jobs={recentJobs} />
      </div>
    </div>
  )
}
