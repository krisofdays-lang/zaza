"use client"

import { Wifi } from "lucide-react"
import type { ReactNode } from "react"

/**
 * A faithful iPhone device shell. The status bar reproduces the iOS look
 * (time on the left, signal/wifi/battery on the right). Children render
 * inside the screen area, which scrolls independently.
 */
export function IphoneFrame({
  children,
  time = "08:27",
  batteryLevel = 18,
  charging = false,
}: {
  children: ReactNode
  time?: string
  batteryLevel?: number
  charging?: boolean
}) {
  const low = batteryLevel <= 20 && !charging
  return (
    <div className="relative mx-auto w-[390px] max-w-full shrink-0">
      {/* Titanium frame */}
      <div className="relative rounded-[3.25rem] bg-[#1c1c1e] p-[3px] shadow-2xl ring-1 ring-white/10">
        <div className="rounded-[3.05rem] bg-black p-[10px]">
          <div className="relative overflow-hidden rounded-[2.4rem] bg-white">
            {/* Dynamic Island */}
            <div className="pointer-events-none absolute left-1/2 top-2 z-30 h-[26px] w-[110px] -translate-x-1/2 rounded-full bg-black" />

            {/* Status bar */}
            <div className="relative z-20 flex h-11 items-center justify-between bg-white px-7 pt-1 text-black">
              <span className="text-[15px] font-semibold tracking-tight tabular-nums">{time}</span>
              <div className="flex items-center gap-1.5">
                <SignalBars />
                <Wifi className="size-[15px]" strokeWidth={2.5} />
                <BatteryIcon level={batteryLevel} low={low} charging={charging} />
              </div>
            </div>

            {/* Scrollable screen */}
            <div className="h-[720px] overflow-y-auto overflow-x-hidden bg-white text-black [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {children}
            </div>

            {/* Home indicator */}
            <div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-20 flex justify-center">
              <div className="h-1 w-32 rounded-full bg-black/80" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SignalBars() {
  return (
    <div className="flex items-end gap-[2px]" aria-hidden>
      {[3, 5, 7, 9].map((h, i) => (
        <span
          key={h}
          className={i < 2 ? "rounded-[1px] bg-black" : "rounded-[1px] bg-black/30"}
          style={{ width: 3, height: h }}
        />
      ))}
    </div>
  )
}

function BatteryIcon({ level, low, charging }: { level: number; low: boolean; charging: boolean }) {
  const fill = low ? "#ff3b30" : charging ? "#34c759" : "#000000"
  return (
    <div className="flex items-center gap-0.5" aria-label={`Battery ${level}%`}>
      <div className="relative h-[12px] w-[24px] rounded-[3px] border border-black/40 p-[1.5px]">
        <div
          className="h-full rounded-[1.5px]"
          style={{ width: `${Math.max(8, Math.min(100, level))}%`, backgroundColor: fill }}
        />
      </div>
      <div className="h-[4px] w-[1.5px] rounded-r bg-black/40" />
    </div>
  )
}
