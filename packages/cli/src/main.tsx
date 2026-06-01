#!/usr/bin/env bun

import { spawn } from "node:child_process"

import {
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"

const PALETTE = {
  surface: "#0c0c0b",
  surfaceRaised: "#18181a",
  border: "#3d3d32",
  borderAccent: "#4e5f29",
  text: "#fafaf8",
  muted: "#b5b5a8",
  dim: "#757568",
  green: "#8bc431",
  cream: "#fce047",
  red: "#fa2d2d",
  amber: "#f59e0b",
  blue: "#60a5fa",
  graphBg: "#101815",
  graphNode: "#E4EFE8",
  graphEdge: "#86E1C8",
  graphActive: "#FFD3A0",
  graphActiveEdge: "#E6B17E",
  graphMuted: "#8DA99B",
  graphTargetBg: "#16220f",
}

type Tone = "green" | "amber" | "red" | "muted" | "blue"

type SpanStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  underlined?: boolean
}

type StyledSpan = {
  text: string
  style: SpanStyle
}

type StyledLine = {
  spans: StyledSpan[]
}

type EnvironmentListItemSnapshot = {
  name: string
  kind: string
  workspaceCount: number
  statusVector: EnvironmentStatusCount[]
  localStateDetected: boolean
  selected: boolean
  repo?: string
  origin?: string
  status?: string
  headSha?: string
  updatedAt?: string
  actor?: string
}

type EnvironmentStatusCount = {
  status: string
  count: number
}

type EnvironmentBrowserSnapshot = {
  environments: EnvironmentListItemSnapshot[]
  footer: string
}

type DetailTabSnapshot = {
  id: string
  label: string
  selected: boolean
}

type EnvironmentGraphSnapshot = {
  selectedNodeId: string
  levels: string[][]
  nodes: EnvironmentGraphNodeSnapshot[]
}

type EnvironmentGraphNodeSnapshot = {
  id: string
  workspacePath: string
  label: string
  dependencies: string[]
  selected: boolean
  targeted: boolean
  status: GraphNodeStatus
  activation?: string
  verification?: string
}

type GraphNodeStatus = "running" | "converged" | "failed" | "waiting" | "present" | "partial" | "absent" | "unknown"

type EnvironmentDetailSnapshot = {
  environmentName: string
  selectedNode: string
  detailSpotlight: boolean
  graph: EnvironmentGraphSnapshot
  selectedWorkspace: SelectedWorkspaceSnapshot | null
  targetSummary: string
  modeLine: string
  governanceLine: string
  focus: "graph" | "detail"
  running: boolean
  runFooter: string
  tabs: DetailTabSnapshot[]
  detailHeaderLines: StyledLine[]
  detailBodyLines: StyledLine[]
  detailScroll: number
  footer: string
}

type SelectedWorkspaceSnapshot = {
  path: string
  status: string
  runState: string
  currentPhase: string
  materialization: string
  freshness: string
  readiness: string
  acceptability: string
  activation: string
  verification: string
}

type ShellSnapshot = {
  view: "environmentList" | "environmentDetail"
  cloud: CloudStatusSnapshot
  capability: TuiCapabilitySnapshot
  browser: EnvironmentBrowserSnapshot
  detail: EnvironmentDetailSnapshot | null
  footerMessage: string
}

type TuiCapabilitySnapshot = {
  mode: "anonymousLocal" | "accountLocal" | "accountRemote" | "accountUnavailable"
  executionLocation: "local" | "remote"
  label: string
  detail: string
  repoFullName?: string
  actionLabel?: string
  actionUrl?: string
}

type CloudStatusSnapshot = {
  kind: "anonymous" | "free" | "paid" | "none" | "expired" | "unavailable"
  label: string
  detail: string
  identity?: string
  expiresAt?: string
  actionLabel?: string
  actionUrl?: string
}

type KeyResponse = {
  data?: {
    action: "quit" | null
  }
}

type GraphAction = "select" | "toggle"

type ScrollBoxWithBars = ScrollBoxRenderable & {
  horizontalScrollBar?: { visible: boolean }
}

const serverUrlEnv = process.env.YAFFLE_TUI_SERVER
const sessionTokenEnv = process.env.YAFFLE_TUI_TOKEN

if (!serverUrlEnv || !sessionTokenEnv) {
  throw new Error("YAFFLE_TUI_SERVER and YAFFLE_TUI_TOKEN must be set")
}

const serverUrl = serverUrlEnv
const sessionToken = sessionTokenEnv

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-yaffle-tui-token": sessionToken,
  }
}

async function loadSnapshot(): Promise<ShellSnapshot> {
  const response = await fetch(`${serverUrl}/snapshot`, {
    headers: headers(),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return (await response.json()) as ShellSnapshot
}

async function sendKey(key: KeyEvent): Promise<KeyResponse> {
  const response = await fetch(`${serverUrl}/key`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: key.name,
      ctrl: key.ctrl,
    }),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return (await response.json()) as KeyResponse
}

async function sendGraphAction(nodeId: string, action: GraphAction): Promise<KeyResponse> {
  const response = await fetch(`${serverUrl}/graph`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ nodeId, action }),
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return (await response.json()) as KeyResponse
}

async function sendShutdown(): Promise<void> {
  await fetch(`${serverUrl}/shutdown`, {
    method: "POST",
    headers: headers(),
  }).catch(() => undefined)
}

function describeIpcError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught)
  if (message.toLowerCase().includes("unable to connect") || message.toLowerCase().includes("connection")) {
    return "Lost connection to the local Yaffle engine. Press q or Ctrl+C to leave the terminal app."
  }
  return message
}

function isQuitKey(key: KeyEvent): boolean {
  return key.name === "q" || (key.ctrl && key.name === "c")
}

function isGraphZoomInKey(key: KeyEvent): boolean {
  return key.name === "+" || key.name === "=" || key.name === "plus" || key.name === "equal" || key.name === "add"
}

function isGraphZoomOutKey(key: KeyEvent): boolean {
  return key.name === "-" || key.name === "_" || key.name === "minus" || key.name === "subtract"
}

function isGraphZoomKey(key: KeyEvent): boolean {
  return isGraphZoomInKey(key) || isGraphZoomOutKey(key)
}

function clampGraphZoom(value: number): number {
  return Math.max(0, Math.min(3, value))
}

function quitRenderer(renderer: CliRenderer): void {
  void sendShutdown().finally(() => renderer.destroy())
}

function App() {
  const renderer = useRenderer()
  const [snapshot, setSnapshot] = useState<ShellSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exiting, setExiting] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [pulse, setPulse] = useState(0)
  const [graphZoom, setGraphZoom] = useState(1)
  const { width, height } = useTerminalDimensions()

  useEffect(() => {
    let disposed = false
    let inflight = false

    const refresh = async () => {
      if (inflight || disposed) {
        return
      }
      inflight = true
      try {
        const next = await loadSnapshot()
        if (!disposed) {
          setSnapshot(next)
          setError(null)
        }
      } catch (caught) {
        if (!disposed) {
          setError(describeIpcError(caught))
        }
      } finally {
        inflight = false
      }
    }

    void refresh()
    const interval = setInterval(() => void refresh(), 90)

    return () => {
      disposed = true
      clearInterval(interval)
      void sendShutdown()
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setPulse((value) => (value + 1) % 8), 140)
    return () => clearInterval(interval)
  }, [])

  useKeyboard((key) => {
    if (key.eventType === "release") {
      return
    }

    if (isQuitKey(key)) {
      setExiting(true)
      quitRenderer(renderer)
      return
    }

    if (key.name === "?" || (key.shift && key.name === "/")) {
      setShowHelp((value) => !value)
      return
    }

    if (showHelp) {
      if (key.name === "escape") {
        setShowHelp(false)
      }
      return
    }

    if (snapshot?.view === "environmentDetail" && isGraphZoomKey(key)) {
      setGraphZoom((value) => clampGraphZoom(value + (isGraphZoomInKey(key) ? 1 : -1)))
      return
    }

    void sendKey(key)
      .then((response) => {
        if (response.data?.action === "quit") {
          renderer.destroy()
        }
      })
      .catch((caught) => {
        setError(describeIpcError(caught))
      })
  })

  if (!snapshot) {
    return <LoadingScreen error={error} exiting={exiting} pulse={pulse} />
  }

  return (
    <box width="100%" height="100%" backgroundColor={PALETTE.surface} padding={1}>
      {snapshot.view === "environmentDetail" && snapshot.detail ? (
        <DetailScreen
          detail={snapshot.detail}
          cloud={snapshot.cloud}
          width={width}
          height={height}
          graphZoom={graphZoom}
          pulse={pulse}
          onError={setError}
        />
      ) : (
        <BrowserScreen browser={snapshot.browser} cloud={snapshot.cloud} />
      )}
      {error ? <OverlayMessage message={error} /> : null}
      {exiting ? <OverlayMessage message="Closing Yaffle..." /> : null}
      {showHelp ? <HelpOverlay view={snapshot.view} /> : null}
    </box>
  )
}

function LoadingScreen({
  error,
  exiting,
  pulse,
}: {
  error: string | null
  exiting: boolean
  pulse: number
}) {
  return (
    <box
      width="100%"
      height="100%"
      backgroundColor={PALETTE.surface}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      gap={1}
    >
      <text fg={PALETTE.text}>
        <strong>Yaffle</strong>
      </text>
      <text fg={PALETTE.muted}>
        {exiting ? "Closing Yaffle..." : `${spinnerFrame(pulse)} loading environment control plane`}
      </text>
      {error ? <text fg={PALETTE.red}>{error}</text> : null}
      {error ? <text fg={PALETTE.muted}>Press q or Ctrl+C to exit.</text> : null}
    </box>
  )
}

function BrowserScreen({
  browser,
  cloud,
}: {
  browser: EnvironmentBrowserSnapshot
  cloud: CloudStatusSnapshot
}) {
  const namedEnvironments = browser.environments.filter((environment) => environment.kind !== "transient")
  const transientEnvironments = browser.environments.filter((environment) => environment.kind === "transient")

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box
        border={[
          "bottom",
        ]}
        borderColor={PALETTE.border}
        backgroundColor={PALETTE.surface}
        paddingX={1}
        flexDirection="row"
        alignItems="center"
        gap={2}
        height={4}
      >
        <box flexDirection="column" width={24}>
          <text fg={PALETTE.text}>
            <strong>Yaffle</strong>
          </text>
          <text fg={PALETTE.dim}>Environments</text>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <text fg={PALETTE.dim}>{browser.environments.length} environment(s)</text>
        </box>
        <CloudStatus cloud={cloud} />
      </box>

      <box
        border
        borderStyle="rounded"
        borderColor={PALETTE.borderAccent}
        title=" Environments "
        backgroundColor={PALETTE.surfaceRaised}
        padding={1}
        flexGrow={1}
        flexDirection="column"
      >
        <scrollbox
          flexGrow={1}
          scrollY
          rootOptions={{ backgroundColor: PALETTE.surfaceRaised }}
          viewportOptions={{ backgroundColor: PALETTE.surfaceRaised }}
          contentOptions={{ backgroundColor: PALETTE.surfaceRaised }}
          scrollbarOptions={{ showArrows: false }}
        >
          {browser.environments.length === 0 ? (
            <text fg={PALETTE.muted}>No environments found.</text>
          ) : (
            <box flexDirection="column" gap={1}>
              <EnvironmentSection title="Named environments" environments={namedEnvironments} />
              <EnvironmentSection title="Transient environments" environments={transientEnvironments} />
            </box>
          )}
        </scrollbox>
      </box>

      <Footer right="? shortcuts" />
    </box>
  )
}

function EnvironmentSection({
  title,
  environments,
}: {
  title: string
  environments: EnvironmentListItemSnapshot[]
}) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text fg={PALETTE.muted}>
          <strong>{title}</strong>
        </text>
        <text fg={PALETTE.dim}>{environments.length}</text>
      </box>
      {environments.length === 0 ? (
        <text fg={PALETTE.dim}>  none</text>
      ) : (
        environments.map((environment) => (
          <EnvironmentRow key={environment.name} environment={environment} />
        ))
      )}
    </box>
  )
}

function EnvironmentRow({ environment }: { environment: EnvironmentListItemSnapshot }) {
  const backgroundColor = environment.selected ? "#1a1a10" : PALETTE.surfaceRaised
  const status = environment.status ?? environment.kind
  const statusColor = toneColor(statusTone(status))
  const metadata = environmentMetadata(environment)

  return (
    <box
      backgroundColor={backgroundColor}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
      gap={1}
    >
      <box flexDirection="row" alignItems="center" gap={1}>
        <box width={2}>
          <text fg={environment.selected ? PALETTE.cream : PALETTE.dim}>{environment.selected ? "›" : " "}</text>
        </box>
        <box width="32%">
          <text fg={environment.selected ? PALETTE.cream : PALETTE.text}>{environment.name}</text>
        </box>
        <box width="24%">
          <text fg={PALETTE.muted}>{environment.repo ?? environment.kind}</text>
        </box>
        <box width="18%">
          <text fg={statusColor}>{status}</text>
        </box>
        <text fg={PALETTE.muted}>{environment.workspaceCount} workspace(s)</text>
      </box>
      {metadata.length > 0 ? (
        <box marginLeft={3} flexDirection="column">
          <text fg={PALETTE.dim}>{metadata[0]}</text>
          {metadata[1] ? <text fg={PALETTE.dim}>{metadata[1]}</text> : null}
        </box>
      ) : null}
    </box>
  )
}

function environmentMetadata(environment: EnvironmentListItemSnapshot): string[] {
  const firstLine = [
    environment.origin,
    environment.headSha ? shortSha(environment.headSha) : null,
    environment.updatedAt ? relativeTime(environment.updatedAt) : null,
    environment.actor ? `@${environment.actor}` : null,
  ].filter(Boolean).join(" · ")
  const secondLine = environment.statusVector.length > 0 ? `workspaces: ${formatStatusVector(environment.statusVector)}` : ""

  return [firstLine, secondLine].filter((line) => line.length > 0)
}

function formatStatusVector(statusVector: EnvironmentStatusCount[]): string {
  return statusVector.map((item) => `${item.count} ${item.status}`).join(" · ")
}

function shortSha(value: string): string {
  return value.length > 7 ? value.slice(0, 7) : value
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }

  const seconds = Math.round((Date.now() - timestamp) / 1000)
  const absSeconds = Math.abs(seconds)
  const units: Array<[number, string]> = [
    [60 * 60 * 24 * 30, "mo"],
    [60 * 60 * 24, "d"],
    [60 * 60, "h"],
    [60, "m"],
  ]
  for (const [unitSeconds, label] of units) {
    if (absSeconds >= unitSeconds) {
      const value = Math.round(absSeconds / unitSeconds)
      return seconds >= 0 ? `${value}${label} ago` : `in ${value}${label}`
    }
  }

  return seconds >= 0 ? `${absSeconds}s ago` : `in ${absSeconds}s`
}

function DetailScreen({
  detail,
  cloud,
  width,
  height,
  graphZoom,
  pulse,
  onError,
}: {
  detail: EnvironmentDetailSnapshot
  cloud: CloudStatusSnapshot
  width: number
  height: number
  graphZoom: number
  pulse: number
  onError: (message: string) => void
}) {
  const maxGraphHeight = width < 90 ? 14 : 18
  const graphHeight = detail.detailSpotlight
    ? Math.max(7, Math.min(10, Math.floor(height * 0.18)))
    : Math.max(10, Math.min(maxGraphHeight, Math.floor(height * 0.32)))
  const targetedWorkspaceCount = detail.graph.nodes.filter((node) => node.targeted).length

  return (
    <box width="100%" height="100%" flexDirection="column">
      <EnvironmentHeader detail={detail} cloud={cloud} />

      <GraphPanel
        detail={detail}
        height={graphHeight}
        compact={detail.detailSpotlight}
        viewportWidth={width}
        zoom={graphZoom}
        onError={onError}
      />

      <DetailPanel detail={detail} spotlight={detail.detailSpotlight} />

      {detail.running ? (
        <Footer left={<RunFooterStatus pulse={pulse} text={detail.runFooter} />} right="? shortcuts" />
      ) : (
        <Footer left={selectedWorkspaceStatus(targetedWorkspaceCount)} right="? shortcuts" />
      )}
    </box>
  )
}

function EnvironmentHeader({
  detail,
  cloud,
}: {
  detail: EnvironmentDetailSnapshot
  cloud: CloudStatusSnapshot
}) {
  return (
    <box
      border={[
        "bottom",
      ]}
      borderColor={PALETTE.border}
      backgroundColor={PALETTE.surface}
      paddingX={1}
      height={4}
      flexDirection="row"
      alignItems="center"
      justifyContent="space-between"
      gap={2}
    >
      <box flexDirection="column" width={28}>
        <text fg={PALETTE.text}>
          <strong>{detail.environmentName}</strong>
        </text>
      </box>

      <CloudStatus cloud={cloud} />
    </box>
  )
}

function GraphPanel({
  detail,
  height,
  compact = false,
  viewportWidth,
  zoom,
  onError,
}: {
  detail: EnvironmentDetailSnapshot
  height: number | `${number}%`
  compact?: boolean
  viewportWidth: number
  zoom: number
  onError: (message: string) => void
}) {
  const graphScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const lastNodeClickRef = useRef<{ nodeId: string; at: number } | null>(null)
  const graphViewportHeight = typeof height === "number" ? Math.max(1, height - 4) : 1
  const graphViewportWidth = Math.max(1, viewportWidth - 6)
  const renderedGraph = useMemo(
    () => renderEnvironmentGraph(detail.graph, graphViewportWidth, graphViewportHeight, zoom),
    [detail.graph, graphViewportHeight, graphViewportWidth, zoom],
  )

  useEffect(() => {
    const scrollBox = graphScrollRef.current as ScrollBoxWithBars | null
    if (scrollBox?.horizontalScrollBar) {
      scrollBox.horizontalScrollBar.visible = false
    }
    graphScrollRef.current?.scrollTo({
      x: Math.max(0, renderedGraph.focus.x - (compact ? 2 : 4)),
      y: Math.max(0, renderedGraph.focus.y - 2),
    })
  }, [
    compact,
    renderedGraph.focus.nodeId,
    renderedGraph.focus.x,
    renderedGraph.focus.y,
  ])

  const handleNodeMouseDown = (node: EnvironmentGraphNodeSnapshot) => {
    const now = Date.now()
    const lastClick = lastNodeClickRef.current
    const action = lastClick && lastClick.nodeId === node.id && now - lastClick.at <= 360 ? "toggle" : "select"
    lastNodeClickRef.current = action === "toggle" ? null : { nodeId: node.id, at: now }
    void sendGraphAction(node.id, action).catch((caught) => onError(describeIpcError(caught)))
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={detail.focus === "graph" ? PALETTE.graphActive : PALETTE.borderAccent}
      backgroundColor={PALETTE.graphBg}
      padding={1}
      marginTop={1}
      height={height}
      flexDirection="column"
    >
      <scrollbox
        ref={graphScrollRef}
        flexGrow={1}
        scrollX
        scrollY
        rootOptions={{ backgroundColor: PALETTE.graphBg }}
        viewportOptions={{ backgroundColor: PALETTE.graphBg }}
        contentOptions={{ backgroundColor: PALETTE.graphBg }}
        scrollbarOptions={{
          showArrows: false,
          trackOptions: {
            foregroundColor: PALETTE.graphBg,
            backgroundColor: PALETTE.graphBg,
          },
        }}
      >
        <box width={renderedGraph.width} height={renderedGraph.height} backgroundColor={PALETTE.graphBg}>
          <TextLines lines={renderedGraph.lines} />
          {renderedGraph.nodes.map((node) => (
            <box
              key={node.node.id}
              position="absolute"
              left={node.x}
              top={node.y}
              width={node.width}
              height={node.height}
              onMouseDown={(event) => {
                event.preventDefault()
                handleNodeMouseDown(node.node)
              }}
            />
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

type GraphRenderResult = {
  lines: StyledLine[]
  focus: GraphFocus
  nodes: RenderedGraphNode[]
  width: number
  height: number
}

type RenderedGraphNode = GraphNodeLayout & {
  node: EnvironmentGraphNodeSnapshot
}

type GraphFocus = {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
}

type GraphPoint = {
  x: number
  y: number
}

type GraphNodeLayout = {
  x: number
  y: number
  width: number
  height: number
  centerY: number
  lines: string[]
}

type GraphNodeSize = {
  width: number
  height: number
  lines: string[]
}

type GraphLayout = {
  nodes: Map<string, GraphNodeLayout>
  width: number
  height: number
}

type GraphCell = {
  char: string
  style: SpanStyle
}

type GraphDirection = "up" | "down" | "left" | "right"

type GraphRoute = {
  sourceId: string
  targetId: string
  points: GraphPoint[]
}

type GraphRouteSegment = {
  routeIndex: number
  segmentIndex: number
  from: GraphPoint
  to: GraphPoint
}

type GraphEdgeRecord = {
  sourceId: string
  targetId: string
  sourcePort: GraphPoint
  targetPort: GraphPoint
}

const GRAPH_MIN_NODE_WIDTH = 10
const GRAPH_MAX_NODE_WIDTH = 26
const GRAPH_RANK_GAP = 10
const GRAPH_NODE_GAP = 4
const GRAPH_PADDING_X = 3
const GRAPH_PADDING_Y = 2
const GRAPH_BUS_CLEARANCE = 3
const GRAPH_NODE_CLEARANCE = 2
const GRAPH_TERMINAL_CLEARANCE = 4
const GRAPH_BRIDGE_HALF_WIDTH = 2

type GraphMetrics = {
  minNodeWidth: number
  maxNodeWidth: number
  rankGap: number
  nodeGap: number
  paddingX: number
  paddingY: number
  busClearance: number
  nodeClearance: number
  terminalClearance: number
  bridgeHalfWidth: number
}

const GRAPH_ZOOM_METRICS: GraphMetrics[] = [
  {
    minNodeWidth: 7,
    maxNodeWidth: 14,
    rankGap: 4,
    nodeGap: 2,
    paddingX: 1,
    paddingY: 1,
    busClearance: 2,
    nodeClearance: 1,
    terminalClearance: 2,
    bridgeHalfWidth: 1,
  },
  {
    minNodeWidth: GRAPH_MIN_NODE_WIDTH,
    maxNodeWidth: GRAPH_MAX_NODE_WIDTH,
    rankGap: GRAPH_RANK_GAP,
    nodeGap: GRAPH_NODE_GAP,
    paddingX: GRAPH_PADDING_X,
    paddingY: GRAPH_PADDING_Y,
    busClearance: GRAPH_BUS_CLEARANCE,
    nodeClearance: GRAPH_NODE_CLEARANCE,
    terminalClearance: GRAPH_TERMINAL_CLEARANCE,
    bridgeHalfWidth: GRAPH_BRIDGE_HALF_WIDTH,
  },
  {
    minNodeWidth: 12,
    maxNodeWidth: 34,
    rankGap: 14,
    nodeGap: 5,
    paddingX: 4,
    paddingY: 3,
    busClearance: 4,
    nodeClearance: 2,
    terminalClearance: 5,
    bridgeHalfWidth: 2,
  },
  {
    minNodeWidth: 14,
    maxNodeWidth: 44,
    rankGap: 18,
    nodeGap: 6,
    paddingX: 5,
    paddingY: 4,
    busClearance: 5,
    nodeClearance: 3,
    terminalClearance: 6,
    bridgeHalfWidth: 3,
  },
]

function graphMetricsForViewport(
  graph: EnvironmentGraphSnapshot,
  viewportWidth: number,
  zoom: number,
): GraphMetrics {
  const base = GRAPH_ZOOM_METRICS[clampGraphZoom(zoom)] ?? GRAPH_ZOOM_METRICS[1]!
  const levelCount = Math.max(1, graph.levels.length || 1)
  if (viewportWidth <= 0 || levelCount <= 1) return base

  const minimumGap = Math.min(base.rankGap, 4)
  const budgetWithBaseGap = Math.floor(
    (viewportWidth - base.paddingX * 2 - base.rankGap * (levelCount - 1)) / levelCount,
  )
  if (budgetWithBaseGap >= base.minNodeWidth) return base

  const compactBudget = Math.floor(
    (viewportWidth - base.paddingX * 2 - minimumGap * (levelCount - 1)) / levelCount,
  )
  return {
    ...base,
    maxNodeWidth: Math.max(7, Math.min(base.maxNodeWidth, compactBudget)),
    minNodeWidth: Math.max(7, Math.min(base.minNodeWidth, compactBudget)),
    rankGap: minimumGap,
    nodeGap: Math.min(base.nodeGap, 2),
    paddingX: Math.min(base.paddingX, 1),
    paddingY: Math.min(base.paddingY, 1),
  }
}

function renderEnvironmentGraph(
  graph: EnvironmentGraphSnapshot,
  viewportWidth: number,
  viewportHeight: number,
  zoom: number,
): GraphRenderResult {
  if (graph.nodes.length === 0) {
    return {
      lines: [{ spans: [{ text: "No workspaces in this environment", style: { fg: PALETTE.muted } }] }],
      focus: { nodeId: "", x: 0, y: 0, width: 1, height: 1 },
      nodes: [],
      width: 1,
      height: 1,
    }
  }

  const metrics = graphMetricsForViewport(graph, viewportWidth, zoom)
  const rawLayout = layoutEnvironmentGraph(graph, metrics)
  const offsetX = Math.max(0, Math.floor((viewportWidth - rawLayout.width) / 2))
  const offsetY = Math.max(0, Math.floor((viewportHeight - rawLayout.height) / 2))
  const layout = shiftGraphLayout(rawLayout, offsetX, offsetY)
  const canvas = makeGraphCanvas(
    Math.max(rawLayout.width + offsetX, viewportWidth),
    Math.max(rawLayout.height + offsetY, viewportHeight),
  )
  const routes = routeEnvironmentGraph(graph, layout, metrics)
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))

  drawGraphRoutes(canvas, routes, graph, metrics)
  for (const node of graph.nodes) {
    const nodeLayout = layout.nodes.get(node.id)
    if (nodeLayout) drawGraphNode(canvas, node, nodeLayout)
  }
  for (const route of routes) {
    const sourceLayout = layout.nodes.get(route.sourceId)
    const source = nodesById.get(route.sourceId)
    if (sourceLayout && source) drawGraphSourceConnector(canvas, source, sourceLayout)

    const targetLayout = layout.nodes.get(route.targetId)
    const target = nodesById.get(route.targetId)
    if (targetLayout && target) drawGraphTargetConnector(canvas, target, targetLayout, edgeStyle(route, graph))
  }

  const selectedLayout = layout.nodes.get(graph.selectedNodeId) ?? [...layout.nodes.values()][0]
  return {
    lines: graphCanvasToLines(canvas),
    focus: {
      nodeId: graph.selectedNodeId,
      x: selectedLayout?.x ?? 0,
      y: selectedLayout?.y ?? 0,
      width: selectedLayout?.width ?? 1,
      height: selectedLayout?.height ?? 1,
    },
    nodes: graph.nodes.flatMap((node) => {
      const layoutNode = layout.nodes.get(node.id)
      return layoutNode ? [{ ...layoutNode, node }] : []
    }),
    width: canvas[0]?.length ?? 1,
    height: canvas.length,
  }
}

function layoutEnvironmentGraph(graph: EnvironmentGraphSnapshot, metrics: GraphMetrics): GraphLayout {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const sizes = new Map(graph.nodes.map((node) => [node.id, nodeSize(node, metrics)]))
  const levels = graph.levels.length > 0 ? graph.levels : [graph.nodes.map((node) => node.id)]
  const rankHeights = levels.map((level) => {
    const nodeSizes = level.flatMap((nodeId) => sizes.get(nodeId) ?? [])
    return nodeSizes.reduce((total, size) => total + size.height, 0) + Math.max(0, nodeSizes.length - 1) * metrics.nodeGap
  })
  const rankWidths = levels.map((level) =>
    Math.max(
      metrics.minNodeWidth,
      ...level.map((nodeId) => sizes.get(nodeId)?.width ?? 0).filter((width) => width > 0),
    ),
  )
  const contentHeight = Math.max(3, ...rankHeights)
  const layouts = new Map<string, GraphNodeLayout>()
  let x = metrics.paddingX

  levels.forEach((level, levelIndex) => {
    const rankWidth = rankWidths[levelIndex] ?? GRAPH_MIN_NODE_WIDTH
    const visibleNodeIds = level.filter((nodeId) => nodesById.has(nodeId))
    let y = metrics.paddingY + Math.floor((contentHeight - (rankHeights[levelIndex] ?? 0)) / 2)

    for (const nodeId of visibleNodeIds) {
      const node = nodesById.get(nodeId)
      if (!node) continue
      const size = sizes.get(nodeId)!
      const left = x + Math.floor((rankWidth - size.width) / 2)
      layouts.set(nodeId, {
        x: left,
        y,
        width: size.width,
        height: size.height,
        centerY: y + Math.floor(size.height / 2),
        lines: size.lines,
      })
      y += size.height + metrics.nodeGap
    }

    x += rankWidth + metrics.rankGap
  })

  return {
    nodes: layouts,
    width: Math.max(1, x - metrics.rankGap + metrics.paddingX),
    height: contentHeight + metrics.paddingY * 2,
  }
}

function shiftGraphLayout(layout: GraphLayout, dx: number, dy: number): GraphLayout {
  if (dx === 0 && dy === 0) return layout
  const shifted = new Map<string, GraphNodeLayout>()
  for (const [nodeId, node] of layout.nodes) {
    shifted.set(nodeId, {
      ...node,
      x: node.x + dx,
      y: node.y + dy,
      centerY: node.centerY + dy,
    })
  }
  return {
    nodes: shifted,
    width: layout.width + dx,
    height: layout.height + dy,
  }
}

function routeEnvironmentGraph(
  graph: EnvironmentGraphSnapshot,
  layout: GraphLayout,
  metrics: GraphMetrics,
): GraphRoute[] {
  const records = graphEdgeRecords(graph, layout)
  const handled = new Set<string>()
  const routes: GraphRoute[] = []

  routeGraphFanOut(records, handled, routes, metrics)
  routeGraphFanIn(records, handled, routes, metrics)

  for (const record of records) {
    if (handled.has(edgeRecordKey(record))) continue
    routes.push({
      sourceId: record.sourceId,
      targetId: record.targetId,
      points: horizontalEdgePath(record.sourcePort, record.targetPort, metrics),
    })
  }

  return routes
}

function graphEdgeRecords(graph: EnvironmentGraphSnapshot, layout: GraphLayout): GraphEdgeRecord[] {
  const records: GraphEdgeRecord[] = []
  for (const node of graph.nodes) {
    const target = layout.nodes.get(node.id)
    if (!target) continue

    for (const dependency of node.dependencies) {
      const source = layout.nodes.get(dependency)
      if (!source) continue

      records.push({
        sourceId: dependency,
        targetId: node.id,
        sourcePort: rightOutside(source),
        targetPort: leftOutside(target),
      })
    }
  }

  return records
}

function routeGraphFanOut(
  records: readonly GraphEdgeRecord[],
  handled: Set<string>,
  routes: GraphRoute[],
  metrics: GraphMetrics,
): void {
  for (const sourceRecords of groupEdgeRecords(records, (record) => record.sourceId).values()) {
    if (sourceRecords.length < 2) continue
    const sourcePort = sourceRecords[0]!.sourcePort
    const targetPorts = sourceRecords.map((record) => record.targetPort)
    const busX = keepBefore(
      sourcePort.x + metrics.busClearance,
      Math.min(...targetPorts.map((point) => point.x)) - metrics.nodeClearance,
    )

    for (const record of sourceRecords) {
      routes.push(routeViaX(record, sourcePort, record.targetPort, busX))
      handled.add(edgeRecordKey(record))
    }
  }
}

function routeGraphFanIn(
  records: readonly GraphEdgeRecord[],
  handled: Set<string>,
  routes: GraphRoute[],
  metrics: GraphMetrics,
): void {
  const unhandledRecords = records.filter((record) => !handled.has(edgeRecordKey(record)))
  for (const targetRecords of groupEdgeRecords(unhandledRecords, (record) => record.targetId).values()) {
    if (targetRecords.length < 2) continue
    const targetPort = targetRecords[0]!.targetPort
    const sourcePorts = targetRecords.map((record) => record.sourcePort)
    const busX = keepAfter(
      targetPort.x - metrics.busClearance,
      Math.max(...sourcePorts.map((point) => point.x)) + metrics.nodeClearance,
    )

    for (const record of targetRecords) {
      routes.push(routeViaX(record, record.sourcePort, targetPort, busX))
      handled.add(edgeRecordKey(record))
    }
  }
}

function routeViaX(record: GraphEdgeRecord, sourcePort: GraphPoint, targetPort: GraphPoint, x: number): GraphRoute {
  return {
    sourceId: record.sourceId,
    targetId: record.targetId,
    points: graphPathThrough([
      sourcePort,
      { x, y: sourcePort.y },
      { x, y: targetPort.y },
      targetPort,
    ]),
  }
}

function horizontalEdgePath(sourcePort: GraphPoint, targetPort: GraphPoint, metrics: GraphMetrics): GraphPoint[] {
  if (sourcePort.x === targetPort.x || sourcePort.y === targetPort.y) {
    return graphPathThrough([sourcePort, targetPort])
  }

  const delta = targetPort.x - sourcePort.x
  const sign = Math.sign(delta)
  if (sign === 0) return graphPathThrough([sourcePort, targetPort])

  const terminalOffset = sign * Math.min(metrics.terminalClearance, Math.max(1, Math.abs(delta) - 1))
  const busX = targetPort.x - terminalOffset
  return graphPathThrough([
    sourcePort,
    { x: busX, y: sourcePort.y },
    { x: busX, y: targetPort.y },
    targetPort,
  ])
}

function groupEdgeRecords(
  records: readonly GraphEdgeRecord[],
  keyForRecord: (record: GraphEdgeRecord) => string,
): Map<string, GraphEdgeRecord[]> {
  const groups = new Map<string, GraphEdgeRecord[]>()
  for (const record of records) {
    const key = keyForRecord(record)
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  return groups
}

function rightOutside(node: GraphNodeLayout): GraphPoint {
  return { x: node.x + node.width, y: node.centerY }
}

function leftOutside(node: GraphNodeLayout): GraphPoint {
  return { x: node.x - 1, y: node.centerY }
}

function keepBefore(preferred: number, boundary: number): number {
  return Math.min(preferred, boundary)
}

function keepAfter(preferred: number, boundary: number): number {
  return Math.max(preferred, boundary)
}

function edgeRecordKey(record: GraphEdgeRecord): string {
  return `${record.sourceId}->${record.targetId}`
}

function segmentKey(routeIndex: number, segmentIndex: number): string {
  return `${routeIndex}:${segmentIndex}`
}

function orderedSpan(left: number, right: number): { start: number; end: number } {
  return left <= right ? { start: left, end: right } : { start: right, end: left }
}

function graphPathThrough(points: readonly GraphPoint[]): GraphPoint[] {
  const path: GraphPoint[] = []
  for (const point of points) {
    const previous = path[path.length - 1]
    if (!previous || previous.x !== point.x || previous.y !== point.y) path.push(point)
  }
  return path
}

function nodeSize(node: EnvironmentGraphNodeSnapshot, metrics: GraphMetrics): GraphNodeSize {
  const lines = compactNodeLabelLines(node.label, metrics)
  const textWidth = Math.max(
    1,
    ...lines.map((line, index) => visualLength(index === 0 ? graphNodeDisplayLine(line, node.targeted) : line)),
  )
  return {
    width: Math.max(metrics.minNodeWidth, Math.min(metrics.maxNodeWidth, textWidth + 4)),
    height: lines.length + 2,
    lines,
  }
}

function compactNodeLabelLines(label: string, metrics: GraphMetrics): string[] {
  const labelCapacity = Math.max(1, metrics.maxNodeWidth - 6)
  const segments = label.split("/").filter(Boolean)
  if (segments.length <= 1) return [truncateText(label, labelCapacity)]

  const lastTwo = segments.slice(-2)
  const joined = lastTwo.join("/")
  if (visualLength(joined) <= labelCapacity) return [joined]

  return lastTwo.map((segment) => truncateText(segment, labelCapacity))
}

function drawGraphNode(canvas: GraphCell[][], node: EnvironmentGraphNodeSnapshot, layout: GraphNodeLayout): void {
  const nodeColor = nodeColorForGraphNode(node)
  const borderStyle = node.selected
    ? { fg: PALETTE.graphActive, bold: true }
    : node.targeted
      ? { fg: PALETTE.green, bold: true }
      : { fg: nodeColor }
  const labelStyle = node.selected
    ? { fg: PALETTE.graphActive, bg: node.targeted ? PALETTE.graphTargetBg : undefined, bold: true }
    : node.targeted
      ? { fg: PALETTE.green, bg: PALETTE.graphTargetBg, bold: true }
      : { fg: nodeColor }

  setGraphText(canvas, layout.x, layout.y, `╭${"─".repeat(layout.width - 2)}╮`, borderStyle)
  for (let row = 1; row < layout.height - 1; row += 1) {
    setGraphText(canvas, layout.x, layout.y + row, "│", borderStyle)
    setGraphText(canvas, layout.x + 1, layout.y + row, " ".repeat(layout.width - 2), labelStyle)
    setGraphText(canvas, layout.x + layout.width - 1, layout.y + row, "│", borderStyle)
  }
  layout.lines.forEach((line, index) => {
    const displayLine = index === 0 ? graphNodeDisplayLine(line, node.targeted) : line
    const textX = layout.x + Math.max(1, Math.floor((layout.width - visualLength(displayLine)) / 2))
    setGraphText(canvas, textX, layout.y + 1 + index, displayLine, labelStyle)
  })
  setGraphText(canvas, layout.x, layout.y + layout.height - 1, `╰${"─".repeat(layout.width - 2)}╯`, borderStyle)
}

function graphNodeDisplayLine(line: string, targeted: boolean): string {
  return `${targeted ? "●" : " "} ${line}`
}

function nodeColorForGraphNode(node: EnvironmentGraphNodeSnapshot): string {
  if (node.status === "failed") return PALETTE.red
  if (node.status === "running" || node.status === "partial") return PALETTE.amber
  return PALETTE.graphNode
}

function drawGraphSourceConnector(
  canvas: GraphCell[][],
  node: EnvironmentGraphNodeSnapshot,
  layout: GraphNodeLayout,
): void {
  const style = node.selected
    ? { fg: PALETTE.graphActiveEdge, bold: true }
    : node.targeted
      ? { fg: PALETTE.green, bold: true }
      : { fg: PALETTE.graphEdge }
  setGraphCell(canvas, layout.x + layout.width - 1, layout.centerY, "├", style)
}

function drawGraphTargetConnector(
  canvas: GraphCell[][],
  node: EnvironmentGraphNodeSnapshot,
  layout: GraphNodeLayout,
  edgeStyle: SpanStyle,
): void {
  const style = node.selected
    ? { fg: PALETTE.graphActiveEdge, bold: true }
    : node.targeted
      ? { fg: PALETTE.green, bold: true }
      : edgeStyle
  setGraphCell(canvas, layout.x, layout.centerY, "┤", style)
}

function drawGraphRoutes(
  canvas: GraphCell[][],
  routes: readonly GraphRoute[],
  graph: EnvironmentGraphSnapshot,
  metrics: GraphMetrics,
): void {
  const crossings = graphRouteCrossings(routes, metrics)
  routes.forEach((route, routeIndex) =>
    drawGraphRoute(canvas, route, edgeStyle(route, graph), routeIndex, crossings, metrics),
  )
}

function drawGraphRoute(
  canvas: GraphCell[][],
  route: GraphRoute,
  style: SpanStyle,
  routeIndex: number,
  crossings: Map<string, number[]>,
  metrics: GraphMetrics,
): void {
  if (route.points.length < 2) return

  for (let index = 1; index < route.points.length; index += 1) {
    const from = route.points[index - 1]!
    const to = route.points[index]!
    const direction = directionBetween(from, to)
    if (!direction) continue
    if (direction === "left" || direction === "right") {
      drawHorizontalRouteSegment(
        canvas,
        from,
        to,
        style,
        crossings.get(segmentKey(routeIndex, index - 1)) ?? [],
        metrics,
      )
    } else {
      walkSegment(from, to, index === 1, (point) => setGraphLineCell(canvas, point.x, point.y, "│", style))
    }
  }

  for (let index = 1; index < route.points.length - 1; index += 1) {
    const previous = route.points[index - 1]!
    const current = route.points[index]!
    const next = route.points[index + 1]!
    const fromDirection = directionBetween(current, previous)
    const toDirection = directionBetween(current, next)
    if (fromDirection && toDirection) {
      setGraphLineCell(canvas, current.x, current.y, lineGlyph(new Set([fromDirection, toDirection])), style)
    }
  }

  const end = route.points[route.points.length - 1]!
  const arrowFrom = route.points[route.points.length - 2]!
  setGraphCell(canvas, end.x, end.y, arrowGlyphBetween(arrowFrom, end), style)
}

function graphRouteCrossings(routes: readonly GraphRoute[], metrics: GraphMetrics): Map<string, number[]> {
  const horizontalSegments: GraphRouteSegment[] = []
  const verticalSegments: GraphRouteSegment[] = []

  routes.forEach((route, routeIndex) => {
    for (let segmentIndex = 1; segmentIndex < route.points.length; segmentIndex += 1) {
      const from = route.points[segmentIndex - 1]!
      const to = route.points[segmentIndex]!
      const direction = directionBetween(from, to)
      if (!direction) continue
      const segment = { routeIndex, segmentIndex: segmentIndex - 1, from, to }
      if (direction === "left" || direction === "right") horizontalSegments.push(segment)
      else verticalSegments.push(segment)
    }
  })

  const crossings = new Map<string, number[]>()
  for (const horizontal of horizontalSegments) {
    const spanX = orderedSpan(horizontal.from.x, horizontal.to.x)
    const xs = verticalSegments
      .filter((vertical) => vertical.routeIndex !== horizontal.routeIndex)
      .filter((vertical) => vertical.from.x > spanX.start + metrics.bridgeHalfWidth)
      .filter((vertical) => vertical.from.x < spanX.end - metrics.bridgeHalfWidth)
      .filter((vertical) => {
        const spanY = orderedSpan(vertical.from.y, vertical.to.y)
        return horizontal.from.y > spanY.start && horizontal.from.y < spanY.end
      })
      .map((vertical) => vertical.from.x)
      .sort((left, right) => left - right)

    if (xs.length > 0) crossings.set(segmentKey(horizontal.routeIndex, horizontal.segmentIndex), xs)
  }

  return crossings
}

function drawHorizontalRouteSegment(
  canvas: GraphCell[][],
  from: GraphPoint,
  to: GraphPoint,
  style: SpanStyle,
  crossings: readonly number[],
  metrics: GraphMetrics,
): void {
  const leftToRight = to.x >= from.x
  const sortedCrossings = leftToRight ? crossings : [...crossings].reverse()
  let cursor = from

  for (const crossingX of sortedCrossings) {
    const bridgeStartX = crossingX + (leftToRight ? -metrics.bridgeHalfWidth : metrics.bridgeHalfWidth)
    const bridgeEndX = crossingX + (leftToRight ? metrics.bridgeHalfWidth : -metrics.bridgeHalfWidth)
    drawStraightHorizontal(canvas, cursor, { x: bridgeStartX, y: from.y }, style)
    drawBridge(canvas, { x: bridgeStartX, y: from.y }, { x: bridgeEndX, y: from.y }, style)
    cursor = { x: bridgeEndX + (leftToRight ? 1 : -1), y: from.y }
  }

  drawStraightHorizontal(canvas, cursor, to, style)
}

function drawStraightHorizontal(canvas: GraphCell[][], from: GraphPoint, to: GraphPoint, style: SpanStyle): void {
  walkSegment(from, to, true, (point) => setGraphLineCell(canvas, point.x, point.y, "─", style))
}

function drawBridge(canvas: GraphCell[][], from: GraphPoint, to: GraphPoint, style: SpanStyle): void {
  const leftToRight = to.x >= from.x
  const lift = from.y >= 2 ? -2 : 2
  const baseVertical = lift < 0 ? "up" : "down"
  const bridgeVertical = lift < 0 ? "down" : "up"
  const topFrom = { x: from.x, y: from.y + lift }
  const topTo = { x: to.x, y: to.y + lift }

  drawVerticalInterior(canvas, from, topFrom, style)
  drawHorizontalInterior(canvas, topFrom, topTo, style)
  drawVerticalInterior(canvas, topTo, to, style)

  setGraphCell(
    canvas,
    from.x,
    from.y,
    lineGlyph(new Set<GraphDirection>(leftToRight ? ["left", baseVertical] : ["right", baseVertical])),
    style,
  )
  setGraphCell(
    canvas,
    topFrom.x,
    topFrom.y,
    lineGlyph(new Set<GraphDirection>(leftToRight ? [bridgeVertical, "right"] : [bridgeVertical, "left"])),
    style,
  )
  setGraphCell(
    canvas,
    topTo.x,
    topTo.y,
    lineGlyph(new Set<GraphDirection>(leftToRight ? ["left", bridgeVertical] : ["right", bridgeVertical])),
    style,
  )
  setGraphCell(
    canvas,
    to.x,
    to.y,
    lineGlyph(new Set<GraphDirection>(leftToRight ? [baseVertical, "right"] : [baseVertical, "left"])),
    style,
  )
}

function drawVerticalInterior(canvas: GraphCell[][], from: GraphPoint, to: GraphPoint, style: SpanStyle): void {
  const step = to.y > from.y ? 1 : -1
  for (let y = from.y + step; y !== to.y; y += step) {
    setGraphLineCell(canvas, from.x, y, "│", style)
  }
}

function drawHorizontalInterior(canvas: GraphCell[][], from: GraphPoint, to: GraphPoint, style: SpanStyle): void {
  const step = to.x > from.x ? 1 : -1
  for (let x = from.x + step; x !== to.x; x += step) {
    setGraphLineCell(canvas, x, from.y, "─", style)
  }
}

function edgeStyle(route: GraphRoute, graph: EnvironmentGraphSnapshot): SpanStyle {
  return route.sourceId === graph.selectedNodeId || route.targetId === graph.selectedNodeId
    ? { fg: PALETTE.graphActiveEdge, bold: true }
    : { fg: PALETTE.graphEdge }
}

function makeGraphCanvas(width: number, height: number): GraphCell[][] {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " ", style: { fg: PALETTE.graphMuted } })),
  )
}

function setGraphText(canvas: GraphCell[][], x: number, y: number, text: string, style: SpanStyle): void {
  Array.from(text).forEach((char, offset) => setGraphCell(canvas, x + offset, y, char, style))
}

function setGraphLineCell(canvas: GraphCell[][], x: number, y: number, char: string, style: SpanStyle): void {
  const existing = graphCellAt(canvas, x, y)
  if (!existing || existing.char === " ") {
    setGraphCell(canvas, x, y, char, style)
    return
  }

  const merged = mergeLineGlyph(existing.char, char)
  if (merged) setGraphCell(canvas, x, y, merged, style)
}

function setGraphCell(canvas: GraphCell[][], x: number, y: number, char: string, style: SpanStyle): void {
  if (y < 0 || y >= canvas.length || x < 0 || x >= canvas[y]!.length) return
  canvas[y]![x] = { char, style }
}

function graphCellAt(canvas: GraphCell[][], x: number, y: number): GraphCell | undefined {
  if (y < 0 || y >= canvas.length || x < 0 || x >= canvas[y]!.length) return undefined
  return canvas[y]![x]
}

function graphCanvasToLines(canvas: GraphCell[][]): StyledLine[] {
  return canvas.map((row) => {
    const trimmedLength = Math.max(0, row.findLastIndex((cell) => cell.char !== " ") + 1)
    const spans: StyledSpan[] = []
    let currentStyle: SpanStyle | undefined
    let currentText = ""

    for (const cell of row.slice(0, trimmedLength)) {
      if (currentStyle && sameStyle(currentStyle, cell.style)) {
        currentText += cell.char
        continue
      }

      if (currentStyle) spans.push({ text: currentText, style: currentStyle })
      currentStyle = cell.style
      currentText = cell.char
    }

    if (currentStyle) spans.push({ text: currentText, style: currentStyle })
    return { spans }
  })
}

function sameStyle(left: SpanStyle, right: SpanStyle): boolean {
  return left.fg === right.fg && left.bg === right.bg && Boolean(left.bold) === Boolean(right.bold) && Boolean(left.underlined) === Boolean(right.underlined)
}

function visualLength(value: string): number {
  return Array.from(value).length
}

function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value)
  if (chars.length <= maxLength) return value
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…`
}

function directionBetween(from: GraphPoint, to: GraphPoint): GraphDirection | undefined {
  if (from.y === to.y) {
    if (to.x > from.x) return "right"
    if (to.x < from.x) return "left"
  }
  if (from.x === to.x) {
    if (to.y > from.y) return "down"
    if (to.y < from.y) return "up"
  }
  return undefined
}

function walkSegment(
  from: GraphPoint,
  to: GraphPoint,
  includeStart: boolean,
  visit: (point: GraphPoint) => void,
): void {
  const direction = directionBetween(from, to)
  if (!direction) return

  const dx = direction === "right" ? 1 : direction === "left" ? -1 : 0
  const dy = direction === "down" ? 1 : direction === "up" ? -1 : 0
  let cursor = includeStart ? from : { x: from.x + dx, y: from.y + dy }

  while (cursor.x !== to.x || cursor.y !== to.y) {
    visit(cursor)
    cursor = { x: cursor.x + dx, y: cursor.y + dy }
  }
}

function lineGlyph(directions: ReadonlySet<GraphDirection>): string {
  const up = directions.has("up")
  const down = directions.has("down")
  const left = directions.has("left")
  const right = directions.has("right")
  if (up && down && left && right) return "┼"
  if (up && down && right) return "├"
  if (up && down && left) return "┤"
  if (left && right && down) return "┬"
  if (left && right && up) return "┴"
  if (up && right) return "╰"
  if (up && left) return "╯"
  if (down && right) return "╭"
  if (down && left) return "╮"
  if (up || down) return "│"
  return "─"
}

function mergeLineGlyph(existing: string, incoming: string): string | undefined {
  const existingDirections = lineDirections(existing)
  const incomingDirections = lineDirections(incoming)
  if (!existingDirections || !incomingDirections) return undefined
  return lineGlyph(new Set([...existingDirections, ...incomingDirections]))
}

function lineDirections(char: string): GraphDirection[] | undefined {
  switch (char) {
    case "─":
      return ["left", "right"]
    case "│":
      return ["up", "down"]
    case "╭":
      return ["right", "down"]
    case "╮":
      return ["left", "down"]
    case "╰":
      return ["up", "right"]
    case "╯":
      return ["up", "left"]
    case "├":
      return ["up", "down", "right"]
    case "┤":
      return ["up", "down", "left"]
    case "┬":
      return ["left", "right", "down"]
    case "┴":
      return ["left", "right", "up"]
    case "┼":
      return ["up", "down", "left", "right"]
    default:
      return undefined
  }
}

function arrowGlyphBetween(from: GraphPoint, to: GraphPoint): string {
  const direction = directionBetween(from, to)
  if (direction === "left") return "◀"
  if (direction === "up") return "▲"
  if (direction === "down") return "▼"
  return "▶"
}

function DetailPanel({
  detail,
  spotlight = false,
}: {
  detail: EnvironmentDetailSnapshot
  spotlight?: boolean
}) {
  const contentScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const visibleBody = useMemo(
    () => detail.detailBodyLines.slice(detail.detailScroll),
    [detail.detailBodyLines, detail.detailScroll],
  )
  const selectedTab = detail.tabs.find((tab) => tab.selected)?.id ?? "overview"

  useEffect(() => {
    if (detail.running && detail.detailScroll === 0) {
      contentScrollRef.current?.scrollTo({
        x: 0,
        y: Math.max(0, visibleBody.length),
      })
    }
  }, [
    detail.detailScroll,
    detail.running,
    detail.selectedWorkspace?.path,
    selectedTab,
    visibleBody.length,
  ])

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={spotlight || detail.focus === "detail" ? PALETTE.cream : PALETTE.borderAccent}
      backgroundColor={PALETTE.surfaceRaised}
      padding={1}
      flexGrow={1}
      flexDirection="column"
      gap={1}
    >
      <WorkspaceSummary workspace={detail.selectedWorkspace} />

      <TabRail tabs={detail.tabs} />

      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={PALETTE.border}
        backgroundColor={PALETTE.surface}
        paddingX={1}
        flexDirection="column"
      >
        <scrollbox
          ref={contentScrollRef}
          flexGrow={1}
          scrollY
          rootOptions={{ backgroundColor: PALETTE.surface }}
          viewportOptions={{ backgroundColor: PALETTE.surface }}
          contentOptions={{ backgroundColor: PALETTE.surface }}
          scrollbarOptions={{ showArrows: false }}
        >
          {detail.detailScroll > 0 ? (
            <text fg={PALETTE.muted}>↑ scrolled {detail.detailScroll} line(s)</text>
          ) : null}
          <TextLines lines={visibleBody} />
        </scrollbox>
      </box>
    </box>
  )
}

function WorkspaceSummary({
  workspace,
}: {
  workspace: SelectedWorkspaceSnapshot | null
}) {
  if (!workspace) {
    return (
      <box border borderStyle="rounded" borderColor={PALETTE.border} backgroundColor={PALETTE.surface} padding={1}>
        <text fg={PALETTE.muted}>No workspace selected.</text>
      </box>
    )
  }

  const runTone = statusTone(workspace.status)

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
      gap={2}
    >
      <text fg={PALETTE.text}>
        <strong>{workspace.path}</strong>
      </text>
      <text fg={toneColor(runTone)}>status: {workspace.status}</text>
    </box>
  )
}

function TabRail({ tabs }: { tabs: DetailTabSnapshot[] }) {
  return (
    <box flexDirection="row" gap={1}>
      {tabs.map((tab) => (
        <box
          key={tab.id}
          backgroundColor={tab.selected ? PALETTE.surface : PALETTE.surfaceRaised}
          paddingX={1}
        >
          <text fg={tab.selected ? PALETTE.cream : PALETTE.muted}>
            {tab.selected ? <strong>{tab.label.toLowerCase()}</strong> : tab.label.toLowerCase()}
          </text>
        </box>
      ))}
    </box>
  )
}

function TextLines({ lines }: { lines: StyledLine[] }) {
  return (
    <box flexDirection="column">
      {lines.map((line, index) => (
        <LineText key={index} line={line} />
      ))}
    </box>
  )
}

function LineText({ line }: { line: StyledLine }) {
  const spans = line.spans.length > 0 ? line.spans : [{ text: " ", style: {} }]
  const isBlank = spans.every((span) => span.text.length === 0)

  return (
    <text fg={PALETTE.text} selectable>
      {isBlank ? " " : spans.map((span, index) => <StyledSpanView key={index} span={span} />)}
    </text>
  )
}

function StyledSpanView({ span }: { span: StyledSpan }) {
  const text = span.text.length > 0 ? span.text : " "
  let content: ReactNode = text

  if (span.style.underlined) {
    content = <u>{content}</u>
  }
  if (span.style.bold) {
    content = <strong>{content}</strong>
  }

  return <span fg={span.style.fg} bg={span.style.bg}>{content}</span>
}

function CloudStatus({ cloud }: { cloud: CloudStatusSnapshot }) {
  const tone = cloudTone(cloud.kind)
  const color = toneColor(tone)
  const actionText = cloud.actionLabel && cloud.actionUrl ? linkText(cloud.actionLabel, cloud.actionUrl) : null
  const detailText = cloud.identity ? `${cloud.identity} • ${cloud.detail}` : cloud.detail

  return (
    <box
      backgroundColor={PALETTE.surfaceRaised}
      width={46}
      flexDirection="column"
    >
      <text fg={color}>
        <strong>{cloud.label}</strong>
      </text>
      <text fg={PALETTE.muted}>{detailText}</text>
      {cloud.actionUrl && actionText ? <ActionLink href={cloud.actionUrl} label={actionText} /> : null}
    </box>
  )
}

function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <box
      focusable
      onMouseDown={(event) => {
        event.preventDefault()
        openExternalUrl(href)
      }}
    >
      <text fg={PALETTE.cream}>
        <u>
          <a href={href}>{label}</a>
        </u>
      </text>
    </box>
  )
}

function linkText(label: string, href: string): string {
  try {
    const url = new URL(href)
    const host = url.host.replace(/^www\./, "")
    return `${label} at ${host}`
  } catch {
    return label
  }
}

function openExternalUrl(href: string): void {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return
  }

  const target = url.toString()
  const [command, args] = process.platform === "darwin"
    ? ["open", [target]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : ["xdg-open", [target]]

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {
    // Terminals that expose OSC-8 hyperlinks can still open the nested <a> target.
  }
}

function HelpOverlay({ view }: { view: ShellSnapshot["view"] }) {
  const graphMode = view === "environmentDetail"
  return (
    <box
      position="absolute"
      right={2}
      top={2}
      width={46}
      border
      borderStyle="rounded"
      borderColor={PALETTE.cream}
      backgroundColor={PALETTE.surface}
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <text fg={PALETTE.cream}>
        <strong>Keyboard shortcuts</strong>
      </text>
      <Shortcut keyName="j/k" label={graphMode ? "move node or scroll detail" : "move environment"} />
      <Shortcut keyName="h/l" label={graphMode ? "move graph level or switch tab" : "reserved"} />
      <Shortcut keyName="enter" label="open selected environment" />
      <Shortcut keyName="space" label="select workspace target" />
      <Shortcut keyName="tab" label="switch graph/detail focus" />
      <Shortcut keyName="+/-" label="zoom graph" />
      <Shortcut keyName="z" label="toggle detail spotlight" />
      <Shortcut keyName="c" label="converge selection" />
      <Shortcut keyName="r" label="reload selected detail tab" />
      <Shortcut keyName="b" label="back" />
      <Shortcut keyName="esc" label="close help" />
      <Shortcut keyName="?" label="toggle help" />
      <Shortcut keyName="q" label="quit" />
    </box>
  )
}

function Shortcut({ keyName, label }: { keyName: string; label: string }) {
  return (
    <box flexDirection="row" gap={1}>
      <box width={8}>
        <text fg={PALETTE.cream}>
          <strong>{keyName}</strong>
        </text>
      </box>
      <text fg={PALETTE.muted}>{label}</text>
    </box>
  )
}

function Footer({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={PALETTE.border}
      backgroundColor={PALETTE.surfaceRaised}
      paddingX={1}
      height={3}
      flexDirection="row"
      alignItems="center"
      gap={1}
    >
      <box flexGrow={1}>{renderFooterContent(left)}</box>
      {right ? <box>{renderFooterContent(right)}</box> : null}
    </box>
  )
}

function renderFooterContent(content: ReactNode): ReactNode {
  return typeof content === "string" ? <text fg={PALETTE.muted}>{content}</text> : content
}

function selectedWorkspaceStatus(count: number): string {
  return `${count} ${count === 1 ? "workspace" : "workspaces"} selected`
}

function ConvergeSpinner({ pulse }: { pulse: number }) {
  return (
    <text fg={PALETTE.green}>
      <strong>{spinnerFrame(pulse)}</strong>
    </text>
  )
}

function RunFooterStatus({ pulse, text }: { pulse: number; text: string }) {
  return (
    <box flexDirection="row" gap={1}>
      <ConvergeSpinner pulse={pulse} />
      <text fg={PALETTE.muted}>{text || "joining active cloud run..."}</text>
    </box>
  )
}

function OverlayMessage({ message }: { message: string }) {
  const color = message.toLowerCase().includes("lost connection") ? PALETTE.red : PALETTE.cream
  return (
    <box
      position="absolute"
      right={2}
      bottom={2}
      width="45%"
      border
      borderStyle="rounded"
      borderColor={color}
      backgroundColor={PALETTE.surface}
      padding={1}
    >
      <text fg={color}>{message}</text>
    </box>
  )
}

function spinnerFrame(index: number): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]
  return frames[index % frames.length] ?? frames[0]
}

function toneColor(tone: Tone): string {
  switch (tone) {
    case "green":
      return PALETTE.green
    case "amber":
      return PALETTE.amber
    case "red":
      return PALETTE.red
    case "muted":
      return PALETTE.muted
    case "blue":
      return PALETTE.blue
  }
}

function cloudTone(kind: CloudStatusSnapshot["kind"]): Tone {
  switch (kind) {
    case "paid":
    case "free":
    case "anonymous":
      return "green"
    case "expired":
      return "amber"
    case "unavailable":
      return "red"
    case "none":
      return "muted"
  }
}

function statusTone(value: string): Tone {
  const normalized = value.toLowerCase()
  if (normalized === "in progress" || normalized === "in_progress") {
    return "green"
  }
  if (normalized.includes("failed") || normalized.includes("blocked") || normalized.includes("unmet")) {
    return "red"
  }
  const activeTerms = [
    "running",
    "pending",
    "progress",
    "planning",
    "applying",
    "activating",
    "recording",
    "collecting",
    "publishing",
    "syncing",
  ]
  if (activeTerms.some((term) => normalized.includes(term))) {
    return "amber"
  }
  if (normalized.includes("succeeded") || normalized.includes("success") || normalized.includes("ready") || normalized.includes("met") || normalized.includes("present")) {
    return "green"
  }
  return "muted"
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 60,
  useMouse: true,
  autoFocus: true,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
  backgroundColor: PALETTE.surface,
})

createRoot(renderer).render(<App />)
