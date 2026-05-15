#!/usr/bin/env bun

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
}

type Tone = "green" | "amber" | "red" | "muted" | "blue"

type SpanStyle = {
  fg?: string
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
  localStateDetected: boolean
  selected: boolean
  repo?: string
  origin?: string
  status?: string
  headSha?: string
  updatedAt?: string
  actor?: string
  lastRun?: string
}

type EnvironmentBrowserSnapshot = {
  headerLines: StyledLine[]
  environments: EnvironmentListItemSnapshot[]
  footer: string
}

type DetailTabSnapshot = {
  id: string
  label: string
  selected: boolean
}

type EnvironmentGraphFocusSnapshot = {
  nodeId: string
  level: number
  row: number
  x: number
  y: number
  width: number
  height: number
}

type EnvironmentDetailSnapshot = {
  environmentName: string
  selectedNode: string
  detailSpotlight: boolean
  graphFocus: EnvironmentGraphFocusSnapshot
  selectedWorkspace: SelectedWorkspaceSnapshot | null
  targetSummary: string
  modeLine: string
  governanceLine: string
  focus: "graph" | "detail"
  running: boolean
  graphLines: StyledLine[]
  tabs: DetailTabSnapshot[]
  detailHeaderLines: StyledLine[]
  detailBodyLines: StyledLine[]
  detailScroll: number
  footer: string
}

type SelectedWorkspaceSnapshot = {
  path: string
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
  mode: "anonymousLocal" | "accountLocal" | "accountRemote"
  executionLocation: "local" | "remote"
  label: string
  detail: string
  repoFullName?: string
}

type CloudStatusSnapshot = {
  kind: "anonymous" | "free" | "paid" | "none" | "expired" | "unavailable"
  label: string
  detail: string
  identity?: string
  expiresAt?: string
}

type KeyResponse = {
  data?: {
    action: "quit" | null
  }
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
        <DetailScreen detail={snapshot.detail} cloud={snapshot.cloud} width={width} height={height} pulse={pulse} />
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
          <TextLines lines={browser.headerLines.slice(1)} />
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

      <Footer text={`${browser.footer} • ? shortcuts`} />
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
  const secondLine = environment.lastRun ? `last run: ${formatLastRun(environment.lastRun)}` : ""

  return [firstLine, secondLine].filter((line) => line.length > 0)
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

function formatLastRun(value: string): string {
  const match = value.match(/^(.*) at (.*)$/)
  if (!match) {
    return value
  }

  return `${match[1]} ${relativeTime(match[2])}`
}

function DetailScreen({
  detail,
  cloud,
  width,
  height,
  pulse,
}: {
  detail: EnvironmentDetailSnapshot
  cloud: CloudStatusSnapshot
  width: number
  height: number
  pulse: number
}) {
  const maxGraphHeight = width < 90 ? 14 : 18
  const graphHeight = detail.detailSpotlight
    ? Math.max(7, Math.min(10, Math.floor(height * 0.18)))
    : Math.max(10, Math.min(maxGraphHeight, Math.floor(height * 0.32)))

  return (
    <box width="100%" height="100%" flexDirection="column">
      <EnvironmentHeader detail={detail} cloud={cloud} pulse={pulse} />

      <GraphPanel detail={detail} height={graphHeight} compact={detail.detailSpotlight} />

      <DetailPanel detail={detail} spotlight={detail.detailSpotlight} />

      <Footer text={`${detail.footer} • ? shortcuts`} />
    </box>
  )
}

function EnvironmentHeader({
  detail,
  cloud,
  pulse,
}: {
  detail: EnvironmentDetailSnapshot
  cloud: CloudStatusSnapshot
  pulse: number
}) {
  const blocked = detail.governanceLine.includes("blocked")
  const workspace = detail.selectedWorkspace
  const workspaceTone = workspace ? statusTone(workspace.runState) : "muted"
  const mode = detail.running ? `${spinnerFrame(pulse)} ${detail.modeLine}` : detail.modeLine

  return (
    <box
      border={[
        "bottom",
      ]}
      borderColor={PALETTE.border}
      backgroundColor={PALETTE.surface}
      paddingX={1}
      height={5}
      flexDirection="row"
      justifyContent="space-between"
      gap={2}
    >
      <box flexDirection="column" width={28}>
        <text fg={PALETTE.text}>
          <strong>{detail.environmentName}</strong>
        </text>
        <text fg={PALETTE.dim}>{detail.focus} focus</text>
      </box>

      <box flexDirection="column" flexGrow={1}>
        <text fg={PALETTE.text}>{workspace?.path ?? detail.selectedNode}</text>
        <text fg={PALETTE.dim}>{detail.targetSummary}</text>
        <text>
          <span fg={detail.running ? PALETTE.amber : PALETTE.green}>{mode}</span>
          <span fg={PALETTE.dim}> · </span>
          <span fg={blocked ? PALETTE.red : PALETTE.green}>{blocked ? "governance block" : "governance clear"}</span>
          <span fg={PALETTE.dim}> · </span>
          <span fg={toneColor(workspaceTone)}>{workspace?.runState ?? "no workspace"}</span>
          {detail.detailSpotlight ? <span fg={PALETTE.amber}> · spotlight</span> : null}
        </text>
      </box>

      <box flexDirection="column" alignItems="flex-end" width={24}>
        <CloudStatus cloud={cloud} compact />
        <text fg={PALETTE.dim}>? shortcuts</text>
      </box>
    </box>
  )
}

function GraphPanel({
  detail,
  height,
  compact = false,
}: {
  detail: EnvironmentDetailSnapshot
  height: number | `${number}%`
  compact?: boolean
}) {
  const graphScrollRef = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    graphScrollRef.current?.scrollTo({
      x: Math.max(0, detail.graphFocus.x - (compact ? 2 : 4)),
      y: Math.max(0, detail.graphFocus.y - 2),
    })
  }, [compact, detail.graphFocus.nodeId, detail.graphFocus.x, detail.graphFocus.y])

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={detail.focus === "graph" ? PALETTE.cream : PALETTE.borderAccent}
      title=" Dependency graph "
      backgroundColor={PALETTE.surfaceRaised}
      padding={1}
      marginTop={1}
      height={height}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between" marginBottom={compact ? 0 : 1}>
        <text fg={PALETTE.dim}>h/l columns · j/k rows · tab changes focus</text>
        <text fg={detail.focus === "graph" ? PALETTE.cream : PALETTE.dim}>
          {detail.focus === "graph" ? "focused" : "tab to focus"}
        </text>
      </box>
      <scrollbox
        ref={graphScrollRef}
        flexGrow={1}
        scrollX
        scrollY
        rootOptions={{ backgroundColor: PALETTE.surfaceRaised }}
        viewportOptions={{ backgroundColor: PALETTE.surfaceRaised }}
        contentOptions={{ backgroundColor: PALETTE.surfaceRaised }}
        scrollbarOptions={{ showArrows: false }}
      >
        <TextLines lines={detail.graphLines} />
      </scrollbox>
    </box>
  )
}

function DetailPanel({
  detail,
  spotlight = false,
}: {
  detail: EnvironmentDetailSnapshot
  spotlight?: boolean
}) {
  const visibleBody = useMemo(
    () => detail.detailBodyLines.slice(detail.detailScroll),
    [detail.detailBodyLines, detail.detailScroll],
  )

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={spotlight || detail.focus === "detail" ? PALETTE.cream : PALETTE.borderAccent}
      title={spotlight ? " Workspace detail · spotlight " : " Workspace detail "}
      backgroundColor={PALETTE.surfaceRaised}
      padding={1}
      flexGrow={1}
      flexDirection="column"
      gap={1}
    >
      <WorkspaceSummary workspace={detail.selectedWorkspace} />

      <WorkspaceChecks workspace={detail.selectedWorkspace} />

      <TabRail tabs={detail.tabs} />

      <box backgroundColor={PALETTE.surfaceRaised} flexDirection="column">
        <TextLines lines={detail.detailHeaderLines} />
      </box>

      <scrollbox
        flexGrow={1}
        scrollY
        rootOptions={{ backgroundColor: PALETTE.surfaceRaised }}
        viewportOptions={{ backgroundColor: PALETTE.surfaceRaised }}
        contentOptions={{ backgroundColor: PALETTE.surfaceRaised }}
        scrollbarOptions={{ showArrows: false }}
      >
        {detail.detailScroll > 0 ? (
          <text fg={PALETTE.muted}>↑ scrolled {detail.detailScroll} line(s)</text>
        ) : null}
        <TextLines lines={visibleBody} />
      </scrollbox>
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

  const runTone = statusTone(workspace.runState)

  return (
    <box
      backgroundColor={PALETTE.surface}
      padding={1}
      flexDirection="row"
      justifyContent="space-between"
      gap={2}
    >
      <box flexDirection="column" flexGrow={1}>
        <text fg={PALETTE.text}>{workspace.path}</text>
        <text fg={PALETTE.muted}>run: {workspace.runState} · phase: {workspace.currentPhase}</text>
      </box>
      <text fg={toneColor(runTone)}>{workspace.materialization} · {workspace.freshness}</text>
    </box>
  )
}

function WorkspaceChecks({ workspace }: { workspace: SelectedWorkspaceSnapshot | null }) {
  if (!workspace) {
    return null
  }

  return (
    <text fg={PALETTE.muted}>
      readiness: {workspace.readiness} · acceptability: {workspace.acceptability} · activation: {workspace.activation} · verification: {workspace.verification}
    </text>
  )
}

function TabRail({ tabs }: { tabs: DetailTabSnapshot[] }) {
  const labels = tabs.map((tab) => (tab.selected ? `[${tab.label}]` : tab.label)).join("  ")

  return (
    <text fg={PALETTE.muted}>{labels}</text>
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

  return <span fg={span.style.fg}>{content}</span>
}

function CloudStatus({ cloud, compact = false }: { cloud: CloudStatusSnapshot; compact?: boolean }) {
  const tone = cloudTone(cloud.kind)
  const color = toneColor(tone)
  const detail = cloud.identity ? `${cloud.identity} • ${cloud.detail}` : cloud.detail

  if (compact) {
    return <text fg={color}>Cloud: {cloud.label}</text>
  }

  return (
    <box
      backgroundColor={PALETTE.surfaceRaised}
      width={46}
      flexDirection="column"
    >
      <text fg={color}>
        <strong>{cloud.label}</strong>
      </text>
      <text fg={PALETTE.muted}>{detail}</text>
    </box>
  )
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
      <Shortcut keyName="z" label="toggle detail spotlight" />
      <Shortcut keyName="c" label="converge selection" />
      <Shortcut keyName="r" label="reload selected detail tab" />
      <Shortcut keyName="b" label="back" />
      <Shortcut keyName="esc" label="close help" />
      <Shortcut keyName="?/q" label="toggle help / quit" />
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

function Footer({ text }: { text: string }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={PALETTE.border}
      backgroundColor={PALETTE.surfaceRaised}
      paddingX={1}
      height={3}
    >
      <text fg={PALETTE.muted}>{text}</text>
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
  return ["∙", "·", "∙", "·", "∙", "·", "∙", "·"][index] ?? "∙"
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
  if (normalized.includes("failed") || normalized.includes("blocked") || normalized.includes("unmet")) {
    return "red"
  }
  if (normalized.includes("running") || normalized.includes("pending") || normalized.includes("progress")) {
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
