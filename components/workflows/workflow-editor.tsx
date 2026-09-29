"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type React from "react"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  ArrowLeft,
  Save,
  Play,
  Square,
  Clock,
  Users,
  GitBranch,
  Repeat,
  Cpu,
  Timer,
} from "lucide-react"
import { toast } from "sonner"
import { nodeTypes, NodeActionsContext, type WfNodeData } from "@/components/workflows/nodes"
import { PALETTE_BY_CATEGORY, CATEGORY_META, getPaletteAction } from "@/lib/workflows/palette"
import { StepPanel } from "@/components/workflows/step-panel"
import { LiveLogs } from "@/components/workflows/live-logs"
import { useWorkflowRun } from "@/components/workflows/use-workflow-run"
import { orderActionNodes, type WorkflowGraph } from "@/lib/workflows/graph"
import { playCompletionChime } from "@/lib/workflows/notify"
import { saveWorkflowGraph } from "@/app/actions/workflows"
import { clampConcurrency } from "@/components/shared/concurrency-control"
import type { WorkflowDetail } from "@/lib/workflows/run-types"
import type { WfAccount, WfMedia } from "@/lib/workflows/types"

const STATUS_LABEL: Record<string, string> = {
  idle: "DRAFT",
  running: "RUNNING",
  done: "DONE",
  error: "ERROR",
  cancelled: "STOPPED",
}

const initialNodes: Node[] = [
  {
    id: "start",
    type: "start",
    position: { x: 240, y: 60 },
    data: { actionKey: "start", label: "Start" },
    deletable: false,
  },
]

// Animated, gradient-tinted edge defaults to give the "alive" feel.
const edgeDefaults = {
  animated: true,
  style: { stroke: "#962fbf", strokeWidth: 2, strokeDasharray: "6 6" },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#962fbf" },
}

function EditorInner({
  workflowId,
  detail,
  accounts,
  media,
}: {
  workflowId: number
  detail: WorkflowDetail | null
  accounts: WfAccount[]
  media: WfMedia[]
}) {
  const router = useRouter()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)

  // Hydrate the canvas from the persisted graph (falling back to a fresh Start
  // node). The selected accounts also come from the saved row. Each node is
  // normalised to guarantee React Flow's required `position` (legacy/seeded rows
  // may omit it), laying any positionless nodes out in a simple column.
  const savedGraph = (detail?.graph as WorkflowGraph | undefined) ?? null
  const hydratedNodes: Node[] =
    savedGraph?.nodes?.length
      ? (savedGraph.nodes as Node[]).map((n, i) => ({
          ...n,
          position: n.position ?? { x: 240, y: 60 + i * 140 },
          deletable: n.id === "start" ? false : n.deletable,
        }))
      : initialNodes
  const [nodes, setNodes, onNodesChange] = useNodesState(hydratedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>((savedGraph?.edges as Edge[]) ?? [])
  const [name, setName] = useState(detail?.name ?? "Untitled Workflow")
  const [accountIds, setAccountIds] = useState<number[]>(
    detail?.accountIds?.length ? detail.accountIds : accounts.map((a) => a.id),
  )

  // Only the accounts this workflow targets (chosen accounts + accounts from the
  // chosen groups) should appear in the per-account Edit Step panels. Without
  // this filter every panel would list ALL accounts, ignoring the selection.
  const selectedAccounts = useMemo(() => {
    const set = new Set(accountIds)
    return accounts.filter((a) => set.has(a.id))
  }, [accounts, accountIds])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [logsOpen, setLogsOpen] = useState((detail?.status ?? "draft") === "running")
  const idRef = useRef(0)

  const accountLabel = useCallback(
    (id: number | null) => {
      if (id == null) return "system"
      const a = accounts.find((acc) => acc.id === id)
      return a ? a.username || a.label : `#${id}`
    },
    [accounts],
  )

  const { state: runState, start: startRun, stop: stopRun } = useWorkflowRun(workflowId, detail, accountLabel)
  const running = runState.status === "running"

  // Notify (toast + chime) the moment a run leaves the "running" state. We track
  // the previous status so the notification fires once, only on a true
  // running -> finished transition (not on initial mount of a finished row).
  const prevStatusRef = useRef(runState.status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = runState.status
    if (prev !== "running") return
    const wf = name?.trim() || "Workflow"
    if (runState.status === "done") {
      playCompletionChime()
      toast.success(`Workflow «${wf}» finished`, { duration: 6000 })
    } else if (runState.status === "error") {
      toast.error(`Workflow «${wf}» finished with errors`, {
        duration: 8000,
        description: runState.error || runState.phase || undefined,
      })
    } else if (runState.status === "cancelled") {
      toast.message(`Workflow «${wf}» stopped`, { duration: 4000 })
    }
  }, [runState.status, name])

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge({ ...params, ...edgeDefaults }, eds))
      setDirty(true)
    },
    [setEdges],
  )

  // Pointer-based drag-and-drop from the palette onto the canvas.
  // We deliberately avoid native HTML5 drag-and-drop (`draggable` + onDrop):
  // Chromium silently swallows the native `drop` event when the React Flow
  // canvas sits under certain ancestors, which made palette blocks impossible to
  // drop onto the canvas. Pointer events are reliable and unaffected by ancestor
  // styling / stacking contexts.
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null)
  const dragKeyRef = useRef<string | null>(null)

  const onPalettePointerDown = useCallback((e: React.PointerEvent, key: string) => {
    e.preventDefault()
    dragKeyRef.current = key
    setDragKey(key)
    setGhostPos({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!dragKey) return
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"

    const onMove = (e: PointerEvent) => setGhostPos({ x: e.clientX, y: e.clientY })
    const onUp = (e: PointerEvent) => {
      const key = dragKeyRef.current
      dragKeyRef.current = null
      setDragKey(null)
      setGhostPos(null)
      if (!key || !rfInstance || !wrapperRef.current) return
      const rect = wrapperRef.current.getBoundingClientRect()
      const insideCanvas =
        e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
      if (!insideCanvas) return
      const action = getPaletteAction(key)
      if (!action) return
      const position = rfInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const id = `n-${Date.now()}-${idRef.current++}`
      const newNode: Node = {
        id,
        type: "action",
        position,
        data: { actionKey: action.key, label: action.label } as WfNodeData,
      }
      setNodes((nds) => nds.concat(newNode))
      setDirty(true)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      document.body.style.userSelect = prevUserSelect
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [dragKey, rfInstance, setNodes])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id)
  }, [])

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null

  function updateNodeLabel(id: string, label: string) {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)))
    setDirty(true)
  }

  function updateNodeConfig(id: string, config: unknown) {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, config } } : n)))
    setDirty(true)
  }

  // Duplicate a node along with all of its Edit Step data (config, reel
  // assignments, file references). Start is unique and never duplicated.
  const duplicateNode = useCallback(
    (id: string) => {
      setNodes((nds) => {
        const orig = nds.find((n) => n.id === id)
        if (!orig || orig.type === "start") return nds
        const fresh: Node = {
          ...orig,
          id: `n-${Date.now()}-${idRef.current++}`,
          position: { x: orig.position.x + 48, y: orig.position.y + 48 },
          data: structuredClone(orig.data),
          selected: false,
        }
        return nds.concat(fresh)
      })
      setDirty(true)
      toast.success("Node duplicated")
    },
    [setNodes],
  )

  // Remove a node (and its connected edges). Start is the entry point and is
  // protected (its deletable flag also blocks the Delete key).
  const deleteNode = useCallback(
    (id: string) => {
      const target = nodes.find((n) => n.id === id)
      if (!target || target.type === "start") return
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      setSelectedId((cur) => (cur === id ? null : cur))
      setDirty(true)
      toast.success("Node deleted")
    },
    [nodes, setNodes, setEdges],
  )

  function currentGraph(): WorkflowGraph {
    return { nodes: nodes as unknown as WorkflowGraph["nodes"], edges: edges as unknown as WorkflowGraph["edges"] }
  }

  // Validate Post Reel steps: each must have at least one account with a reel
  // selected (others are skipped at run time). Returns the offending node id.
  function findIncompleteReel(): string | null {
    const bad = nodes.find((n) => {
      if ((n.data as WfNodeData)?.actionKey !== "post_reel") return false
      const cfg = (n.data as WfNodeData).config as
        | { assignments?: { mediaId: number | null }[] }
        | undefined
      return !cfg?.assignments?.some((a) => a.mediaId)
    })
    return bad?.id ?? null
  }

  async function handleSave() {
    const incomplete = findIncompleteReel()
    if (incomplete) {
      setSelectedId(incomplete)
      toast.error("Select a reel for at least one account in every Post Reel step.")
      return
    }
    const res = await saveWorkflowGraph(workflowId, { name, graph: currentGraph(), accountIds })
    if (res.ok) {
      setDirty(false)
      toast.success("Workflow saved", { duration: 2000 })
    } else {
      toast.error("Could not save workflow")
    }
  }

  const actionCount = nodes.filter((n) => n.type === "action").length

  // Read-only mirror of the Start node's concurrency for the toolbar indicator.
  // The actual setting is edited inside the Start step's Edit Steps panel.
  const startConcurrency = clampConcurrency(
    Number((nodes.find((n) => n.id === "start")?.data?.config as { concurrency?: number } | undefined)?.concurrency) ||
      1,
    accountIds.length,
  )

  // Start a run: auto-save the graph, then launch the detached server runner.
  // The hook polls the row for live progress/logs; Stop flips the cancel flag.
  async function handleRun() {
    if (running) {
      await stopRun()
      toast.message("Stopping workflow…")
      return
    }
    const order = orderActionNodes(currentGraph())
    if (order.length === 0) {
      toast.error("Add at least one step connected to Start before running.")
      return
    }
    const incomplete = findIncompleteReel()
    if (incomplete) {
      setSelectedId(incomplete)
      toast.error("Select a reel for at least one account in every Post Reel step.")
      return
    }
    if (accountIds.length === 0) {
      toast.error("No accounts selected to run.")
      return
    }
    const graph = currentGraph()
    setDirty(false)
    setLogsOpen(true)
    const res = await startRun({ name, graph, accountIds })
    if (!res.ok) toast.error(res.error ?? "Could not start workflow")
  }

  return (
    <NodeActionsContext.Provider
      value={{
        onDuplicate: duplicateNode,
        running,
        progress: runState.progress,
        activeNodeId: running ? runState.currentNodeId : "",
      }}
    >
    <div className="flex h-svh flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => router.push("/workflows")}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setDirty(true)
              }}
              className="h-8 w-56 border-transparent bg-transparent px-1 text-lg font-semibold hover:border-border focus-visible:border-border"
              aria-label="Workflow name"
            />
            <Badge
              variant={running ? "default" : "secondary"}
              className={`text-[10px] ${running ? "ig-gradient text-white" : ""}`}
            >
              {STATUS_LABEL[runState.status] ?? "DRAFT"}
            </Badge>
            {dirty && !running && <span className="text-xs text-amber-400">Unsaved changes</span>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" /> {accountIds.length} account{accountIds.length === 1 ? "" : "s"}
          </span>
          <Button variant={running ? "destructive" : "outline"} onClick={handleRun}>
            {running ? <Square className="size-4" /> : <Play className="size-4" />}
            {running ? "Stop" : "Run"}
          </Button>
          <Button className="ig-gradient text-white" onClick={handleSave} disabled={running}>
            <Save className="size-4" /> Save
          </Button>
        </div>
      </header>

      {/* Meta toolbar */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-card/60 px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Repeat className="size-3.5" /> Run once
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="size-3.5" /> 09:00 - 18:00 <span className="text-muted-foreground/60">(540 min)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Cpu className="size-3.5" />
          {startConcurrency <= 1 ? "Sequential" : `${startConcurrency} parallel`}
        </span>
        <span className="flex items-center gap-1.5">
          <Timer className="size-3.5" /> ~2 min
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <GitBranch className="size-3.5" /> {actionCount} action{actionCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* Main: palette + canvas + panel */}
      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/40 p-3 lg:flex">
          {PALETTE_BY_CATEGORY.map((cat) => (
            <div key={cat.key} className="mb-4">
              <p
                className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: CATEGORY_META[cat.key].color }}
              >
                {cat.label}
              </p>
              <div className="flex flex-col gap-1.5">
                {cat.actions.map((a) => {
                  const Icon = a.icon
                  const color = CATEGORY_META[a.category].color
                  return (
                    <div
                      key={a.key}
                      onPointerDown={(e) => onPalettePointerDown(e, a.key)}
                      className="flex cursor-grab touch-none select-none items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/50 hover:bg-accent/40 active:cursor-grabbing"
                    >
                      <span
                        className="flex size-6 items-center justify-center rounded-md"
                        style={{ background: `color-mix(in oklch, ${color} 20%, transparent)`, color }}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <span className="font-medium">{a.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </aside>

        {/* Canvas */}
        <div ref={wrapperRef} className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRfInstance}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelectedId(null)}
            onNodesDelete={(deleted) => {
              if (deleted.some((n) => n.id === selectedId)) setSelectedId(null)
              setDirty(true)
            }}
            deleteKeyCode={["Delete", "Backspace"]}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={edgeDefaults}
            fitView
            proOptions={{ hideAttribution: true }}
            className="bg-background"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="oklch(0.4 0.01 300)" />
            <Controls className="!rounded-lg !border !border-border !bg-card [&_button]:!border-border [&_button]:!bg-card [&_button]:!fill-foreground" />
          </ReactFlow>

          {/* Live logs — collapsible panel streaming per-account activity */}
          <LiveLogs
          state={runState}
          open={logsOpen}
          onToggle={setLogsOpen}
          accounts={selectedAccounts.map((a) => a.username || a.label || `#${a.id}`)}
        />
        </div>

        {/* Edit Step panel */}
        {selectedNode && (
          <StepPanel
            key={selectedNode.id}
            node={selectedNode}
            accounts={selectedAccounts}
            media={media}
            onClose={() => setSelectedId(null)}
            onDuplicate={() => duplicateNode(selectedNode.id)}
            onDelete={() => deleteNode(selectedNode.id)}
            onLabelChange={(label) => updateNodeLabel(selectedNode.id, label)}
            onConfigChange={(config) => updateNodeConfig(selectedNode.id, config)}
          />
        )}
      </div>

      {/* Floating preview that follows the cursor while dragging a palette block. */}
      {dragKey && ghostPos && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg border border-primary/60 bg-card px-3 py-2 text-sm font-medium shadow-lg"
          style={{ left: ghostPos.x + 12, top: ghostPos.y + 12 }}
        >
          {getPaletteAction(dragKey)?.label ?? "Block"}
        </div>
      )}
    </div>
    </NodeActionsContext.Provider>
  )
}

export function WorkflowEditor({
  workflowId,
  detail,
  accounts,
  media,
}: {
  workflowId: number
  detail: WorkflowDetail | null
  accounts: WfAccount[]
  media: WfMedia[]
}) {
  return (
    <ReactFlowProvider>
      <EditorInner workflowId={workflowId} detail={detail} accounts={accounts} media={media} />
    </ReactFlowProvider>
  )
}
