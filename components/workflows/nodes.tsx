"use client"

import { createContext, memo, useContext } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { Copy } from "lucide-react"
import { getPaletteAction, CATEGORY_META, StartIcon } from "@/lib/workflows/palette"

export interface WfNodeData {
  actionKey: string
  label: string
  selected?: boolean
  [key: string]: unknown
}

// Lets custom nodes trigger editor-level actions (duplicate) and read live run
// progress without prop drilling, while still mutating the editor's own state.
export const NodeActionsContext = createContext<{
  onDuplicate?: (id: string) => void
  running?: boolean
  progress?: Record<string, { done: number; total: number }>
  // Id of the node currently executing, so it can be visibly highlighted.
  activeNodeId?: string
}>({})

// Shared handle styling — small dots top (target) and bottom (source).
function NodeHandles({ color }: { color: string }) {
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!size-3 !border-2 !border-background"
        style={{ background: color }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-3 !border-2 !border-background"
        style={{ background: color }}
      />
    </>
  )
}

// The default Start node — always present, only emits a connection.
export const StartNode = memo(function StartNode({ selected }: NodeProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border-2 px-6 py-4 shadow-lg transition-colors ${
        selected ? "border-emerald-400" : "border-emerald-500/60"
      }`}
      style={{ background: "color-mix(in oklch, #10b981 16%, var(--card))" }}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-300">
        <StartIcon className="size-5" fill="currentColor" />
      </span>
      <span className="text-base font-semibold text-emerald-100">Start</span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-3 !border-2 !border-background !bg-emerald-400"
      />
    </div>
  )
})

// A draggable action node placed on the canvas.
export const ActionNode = memo(function ActionNode({ id, data, selected }: NodeProps) {
  const d = data as WfNodeData
  const action = getPaletteAction(d.actionKey)
  const color = action ? CATEGORY_META[action.category].color : "#fa7e1e"
  const Icon = action?.icon
  const { onDuplicate, running, progress, activeNodeId } = useContext(NodeActionsContext)
  const prog = progress?.[id]
  const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0
  const showProgress = Boolean(running || (prog && prog.done > 0))
  const isActive = Boolean(activeNodeId && activeNodeId === id)

  return (
    <div
      className={`group relative flex min-w-44 flex-col gap-3 rounded-2xl border-2 bg-card px-5 py-4 shadow-lg transition-colors ${
        isActive ? "node-active-pulse" : selected ? "" : "border-transparent"
      }`}
      style={
        isActive || selected
          ? { borderColor: color, ...(isActive ? { ["--node-active" as string]: color } : {}) }
          : { borderColor: `color-mix(in oklch, ${color} 35%, transparent)` }
      }
    >
      {/* Duplicate this node (with all its Edit Step data) — shown on hover. */}
      {onDuplicate && (
        <button
          type="button"
          aria-label={`Duplicate ${d.label}`}
          title="Duplicate node"
          onClick={(e) => {
            e.stopPropagation()
            onDuplicate(id)
          }}
          className="nodrag absolute -right-2 -top-2 z-10 flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          <Copy className="size-3" />
        </button>
      )}
      <div className="flex items-center gap-3">
        <span
          className="flex size-9 items-center justify-center rounded-lg"
          style={{ background: `color-mix(in oklch, ${color} 22%, transparent)`, color }}
        >
          {Icon ? <Icon className="size-5" /> : null}
        </span>
        <span className="text-base font-semibold">{d.label}</span>
      </div>

      {/* Aggregate run progress across all accounts on this step. */}
      {showProgress && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, backgroundColor: color }}
            />
          </div>
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
            {prog?.done ?? 0}/{prog?.total ?? 0}
          </span>
        </div>
      )}

      <NodeHandles color={color} />
    </div>
  )
})

export const nodeTypes = {
  start: StartNode,
  action: ActionNode,
}
