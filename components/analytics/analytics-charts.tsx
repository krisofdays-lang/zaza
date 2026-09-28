"use client"

import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell, Pie, PieChart } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { AccountAnalytics } from "@/app/actions/analytics"
import { formatCompact } from "./reel-card"

const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

export function AnalyticsCharts({ accounts }: { accounts: AccountAnalytics[] }) {
  // Bar chart: views per account (top 8 by views).
  const barData = useMemo(
    () =>
      [...accounts]
        .sort((a, b) => b.views - a.views)
        .slice(0, 8)
        .map((a) => ({ name: `@${a.username}`, views: a.views, likes: a.likes })),
    [accounts],
  )

  // Donut: view share among the top 5 accounts, the rest grouped as "Others".
  const pieData = useMemo(() => {
    const sorted = [...accounts].sort((a, b) => b.views - a.views)
    const top = sorted.slice(0, 5).map((a) => ({ name: `@${a.username}`, value: a.views }))
    const othersTotal = sorted.slice(5).reduce((s, a) => s + a.views, 0)
    if (othersTotal > 0) top.push({ name: "Others", value: othersTotal })
    return top.filter((d) => d.value > 0)
  }, [accounts])

  const barConfig: ChartConfig = {
    views: { label: "Views", color: "var(--chart-1)" },
    likes: { label: "Likes", color: "var(--chart-2)" },
  }
  const pieConfig: ChartConfig = { value: { label: "Views" } }

  const hasData = accounts.some((a) => a.views > 0)

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      {/* Views by account */}
      <section className="rounded-2xl border border-border bg-card p-5 velvet-card velvet-surface">
        <h2 className="text-sm font-semibold">Views by account</h2>
        <p className="text-xs text-muted-foreground">Total reel views per account (top 8)</p>
        {hasData ? (
          <ChartContainer config={barConfig} className="mt-4 h-[300px] w-full">
            <BarChart accessibilityLayer data={barData} margin={{ left: 4, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} interval={0} angle={-12} textAnchor="end" height={48} />
              <YAxis tickLine={false} axisLine={false} width={40} fontSize={11} tickFormatter={(v) => formatCompact(Number(v))} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="views" fill="var(--color-views)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyChart />
        )}
      </section>

      {/* View share donut */}
      <section className="rounded-2xl border border-border bg-card p-5 velvet-card velvet-surface">
        <h2 className="text-sm font-semibold">View share</h2>
        <p className="text-xs text-muted-foreground">Distribution of views across accounts</p>
        {hasData ? (
          <ChartContainer config={pieConfig} className="mt-4 h-[300px] w-full">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2} strokeWidth={2}>
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
        ) : (
          <EmptyChart />
        )}
      </section>
    </div>
  )
}

function EmptyChart() {
  return (
    <div className="mt-4 flex h-[300px] items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
      No view data to chart yet.
    </div>
  )
}
