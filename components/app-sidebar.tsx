"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  Layers,
  Orbit,
  FolderOpen,
  Send,
  BarChart3,
  Workflow,
  Flame,
  PanelLeftClose,
  PanelLeft,
  ShieldCheck,
  Bot,
  LogOut,
} from "lucide-react"
import { logoutAction } from "@/app/actions/auth"

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/groups", label: "Groups", icon: Layers },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/warmup", label: "Warm up", icon: Flame },
  { href: "/publications", label: "Publications", icon: Send },
  { href: "/storage", label: "Storage", icon: FolderOpen },
]

const ADMIN_NAV = [
  { href: "/autoreg", label: "Auto Reg", icon: Bot },
  { href: "/admin", label: "Admin", icon: ShieldCheck },
]

function useIsActive() {
  const pathname = usePathname()
  return (href: string) => {
    if (href === "/dashboard") return pathname === "/" || pathname.startsWith("/dashboard")
    return pathname.startsWith(href)
  }
}

export function AppSidebar({ isAdmin = false, licenseKey = "" }: { isAdmin?: boolean; licenseKey?: string }) {
  const isActive = useIsActive()
  const [isLoggingOut, startLogout] = useTransition()
  const [collapsed, setCollapsed] = useState(false)
  // Avoid a hydration flash: read the stored preference after mount.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    setCollapsed(localStorage.getItem("orbit:sidebar-collapsed") === "1")
  }, [])

  // Mask all but the last 4 chars of the license key for the footer chip.
  const maskedKey = licenseKey ? `••••${licenseKey.slice(-4)}` : ""

  const navItems = isAdmin ? [...NAV, ...ADMIN_NAV] : NAV

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem("orbit:sidebar-collapsed", next ? "1" : "0")
      return next
    })
  }

  return (
    <aside
      className={cn(
        "hidden md:flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-300 ease-in-out",
        collapsed ? "w-[4.5rem]" : "w-60",
        // Until mounted we render expanded to match the server output.
        !mounted && "w-60",
      )}
    >
      <div className="flex items-center h-16 border-b border-border px-3.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl ig-gradient-animated text-white shadow-sm">
          <Orbit className="size-5" />
        </div>
        <div
          className={cn(
            "ml-2.5 overflow-hidden leading-tight transition-all duration-300",
            collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
          )}
        >
          <p className="whitespace-nowrap font-semibold tracking-tight">Orbit</p>
          <p className="whitespace-nowrap text-xs text-muted-foreground">Account control</p>
        </div>
      </div>

      <nav className={cn("flex flex-col p-3", collapsed ? "items-center gap-2" : "gap-1")}>
        {navItems.map((item) => {
          const Icon = item.icon
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "group relative flex items-center overflow-hidden text-sm font-medium transition-all duration-300",
                collapsed ? "size-11 justify-center rounded-xl" : "gap-3 rounded-lg px-3 py-2.5",
                active
                  ? "ig-gradient text-white shadow-md"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                !active && !collapsed && "hover:translate-x-0.5",
              )}
            >
              <Icon className={cn("size-4 shrink-0 transition-transform duration-300", active && "scale-110")} />
              <span
                className={cn(
                  "whitespace-nowrap transition-all duration-300",
                  collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
                )}
              >
                {item.label}
              </span>
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto border-t border-border p-3 flex flex-col gap-1">
        {!collapsed && maskedKey && (
          <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Key {maskedKey}
          </p>
        )}

        <button
          type="button"
          onClick={() => startLogout(() => logoutAction())}
          disabled={isLoggingOut}
          aria-label="Log out"
          title="Log out"
          className={cn(
            "flex w-full items-center rounded-lg py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
          )}
        >
          <LogOut className="size-4 shrink-0" />
          <span
            className={cn(
              "whitespace-nowrap transition-all duration-300",
              collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
            )}
          >
            {isLoggingOut ? "Logging out…" : "Log out"}
          </span>
        </button>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex w-full items-center rounded-lg py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
          )}
        >
          {collapsed ? (
            <PanelLeft className="size-4 shrink-0" />
          ) : (
            <PanelLeftClose className="size-4 shrink-0" />
          )}
          <span
            className={cn(
              "whitespace-nowrap transition-all duration-300",
              collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
            )}
          >
            Collapse
          </span>
        </button>
      </div>
    </aside>
  )
}

export function MobileTopNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const isActive = useIsActive()
  const items = isAdmin ? [...NAV, ...ADMIN_NAV] : NAV
  return (
    <div className="md:hidden flex items-center gap-1 border-b border-border bg-sidebar px-2 py-2 overflow-x-auto">
      {items.map((item) => {
        const Icon = item.icon
        const active = isActive(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-all duration-300",
              active ? "ig-gradient text-white shadow-sm" : "text-muted-foreground hover:bg-sidebar-accent/60",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}
