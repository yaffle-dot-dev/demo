<script lang="ts">
  import { page } from "$app/stores"
  import { goto } from "$app/navigation"
  import { base } from "$app/paths"
  import { untrack } from "svelte"
  import type {
    EnvironmentLifecycleSummary,
    LifecycleItemSummary,
    Run,
    RunGroup,
    ResourceSpan,
    WorkspacePreview,
    WorkspaceWithRuns,
  } from "$lib/api"
  import { cancelRun, rerunPreview } from "$lib/api"
  import { githubTreeUrl, githubCommitUrl } from "$lib/github"
  import { useRunLogStream } from "$lib/run-log-stream.svelte"
  import type { RunViewCorrelation, RunViewTelemetryEvent } from "$lib/run-view-monitoring"
  import { shortSha, statusConfig, formatRelativeTime } from "$lib/status"
  import {
    getBlockingUpstreamWorkspacePaths,
    getWorkspaceDisplayRuns,
    getWorkspaceConnectionBlockReason,
    getWorkspaceDisplayStatus,
    isWorkspaceActivelyRunningStatus,
    isWorkspaceInProgressStatus,
  } from "$lib/workspace-status"
  import {
    getWorkspacesInRunGroup,
    getLatestRunGroup,
  } from "$lib/sse/types"
  import DagVisualization from "./DagVisualization.svelte"
  import Terminal from "./Terminal.svelte"
  import PlanSummary from "./PlanSummary.svelte"
  import OutputsView from "./OutputsView.svelte"
  import ResourceTimeline from "./ResourceTimeline.svelte"
  import RunGroupStatusBadge from "./RunGroupStatusBadge.svelte"
  import RefBadge from "./RefBadge.svelte"
  import ConnectionBlockedBadge from "./ConnectionBlockedBadge.svelte"
  import type { EnvironmentPolicySummary } from "$lib/api"
  import {
    buildPreviewDag,
    type PreviewDagNode,
    type PreviewLifecycleDagNode,
  } from "$lib/lifecycle-dag"
  import { computeCliAlignedColumns } from "$lib/dag-layout-cli"

  interface Props {
    type: "pr" | "env"
    org: string
    repo: string
    identifier: number | string // PR number or branch name
    ref: string
    headSha: string
    authorLogin?: string | null
    environmentPolicy?: EnvironmentPolicySummary | null
    environmentLifecycle?: EnvironmentLifecycleSummary | null
    workspaces: WorkspaceWithRuns[]
    runGroups: RunGroup[]
    githubUrl: string
    streaming?: boolean
    /** When set, display this specific run group instead of the latest */
    viewedRunGroupId?: string | null
    /** Whether a newer run group exists beyond the pinned view */
    hasNewerRunGroup?: boolean
    /** Latest head SHA (for showing in new run badge) */
    latestHeadSha?: string | null
    /** Callback to unpin and switch to latest run group */
    onSwitchToLatest?: () => void
    /** Whether current user can manage org connections */
    canManageConnections?: boolean
    /** Navigation start time for first-render timing */
    runViewStartMs?: number | null
    /** Correlation IDs for run-view monitoring */
    runViewCorrelation?: RunViewCorrelation | null
    /** Optional run-view telemetry sink */
    onTrackRunViewEvent?: ((event: RunViewTelemetryEvent) => void) | null
  }
  
  /** Extract display name from a full ref (e.g., "refs/heads/main" -> "main") */
  function refName(ref: string): string {
    return ref.replace(/^refs\/(heads|tags)\//, "")
  }

  let props: Props = $props()

  // Explicitly derive frequently-changing props so downstream $derived chains react
  const type = $derived(props.type)
  const org = $derived(props.org)
  const repo = $derived(props.repo)
  const identifier = $derived(props.identifier)
  const ref = $derived(props.ref)
  const headSha = $derived(props.headSha)
  const authorLogin = $derived(props.authorLogin ?? null)
  const environmentPolicy = $derived(props.environmentPolicy ?? null)
  const environmentLifecycle = $derived(props.environmentLifecycle ?? null)
  const workspaces = $derived(props.workspaces)
  const runGroups = $derived(props.runGroups ?? [])
  const githubUrl = $derived(props.githubUrl)
  const streaming = $derived(props.streaming ?? false)
  const viewedRunGroupId = $derived(props.viewedRunGroupId ?? null)
  const hasNewerRunGroup = $derived(props.hasNewerRunGroup ?? false)
  const latestHeadSha = $derived(props.latestHeadSha ?? null)
  const onSwitchToLatest = $derived(props.onSwitchToLatest ?? null)
  const canManageConnections = $derived(props.canManageConnections ?? false)
  const runViewStartMs = $derived(props.runViewStartMs ?? null)
  const runViewCorrelation = $derived(props.runViewCorrelation ?? null)
  const onTrackRunViewEvent = $derived(props.onTrackRunViewEvent ?? null)

  // Get the run group we're viewing
  const viewedRunGroup = $derived.by((): RunGroup | null => {
    if (viewedRunGroupId) {
      return runGroups.find((rg) => rg.id === viewedRunGroupId) ?? null
    }
    // Not pinned: show the latest run group (runGroups is sorted by createdAt DESC)
    // We always show the latest - if it's running/pending, great; if completed, that's fine too.
    // Previously this tried to find ANY running run group, but that caused bugs when old
    // run groups were stuck in "running" status.
    return runGroups[0] ?? null
  })

  const systemError = $derived(viewedRunGroup?.systemError ?? null)

  const manualScopeWorkspacePaths = $derived.by(() =>
    viewedRunGroup?.trigger === "manual"
      ? new Set(viewedRunGroup.selectedWorkspacePaths ?? [])
      : null,
  )

  const canonicalEnvironmentGraph = $derived.by(() => {
    const graphs = runGroups
      .map((runGroup) => runGroup.dependencyGraph)
      .filter((graph): graph is NonNullable<RunGroup["dependencyGraph"]> => !!graph)

    return graphs.sort((left, right) => right.workspaces.length - left.workspaces.length)[0] ?? null
  })

  const displayDependencyGraph = $derived.by(() => {
    if (
      viewedRunGroup?.dependencyGraph
      && (viewedRunGroup.trigger !== "manual"
        || !canonicalEnvironmentGraph
        || viewedRunGroup.dependencyGraph.workspaces.length >= canonicalEnvironmentGraph.workspaces.length)
    ) {
      return viewedRunGroup.dependencyGraph
    }

    return canonicalEnvironmentGraph
  })

  // Workspaces with runs filtered to the viewed run group
  const workspacesWithRuns = $derived.by((): WorkspaceWithRuns[] => {
    if (!viewedRunGroup) {
      return []
    }
    return getWorkspacesInRunGroup(workspaces, viewedRunGroup.id)
  })

  const isLatestRunGroup = $derived(viewedRunGroup?.id === runGroups[0]?.id)
  const usingFreshPendingDag = $derived(
    !!viewedRunGroup
      && isLatestRunGroup
      && workspaces.length === 0
      && workspacesWithRuns.length === 0
      && (viewedRunGroup.status === "scanning"
        || viewedRunGroup.status === "pending"
        || viewedRunGroup.status === "running")
      && !!displayDependencyGraph
      && displayDependencyGraph.workspaces.length > 0
  )

  // Build the complete list of workspaces from the dependency graph.
  // For workspaces without runs yet, create placeholder entries showing "Queued" status.
  const filteredWorkspaces = $derived.by((): WorkspaceWithRuns[] => {
    if (!viewedRunGroup) {
      return []
    }

    const graph = displayDependencyGraph
    if (!graph || graph.workspaces.length === 0) {
      // No dependency graph, fall back to workspaces with runs
      return workspacesWithRuns.map((workspace) => ({
        ...workspace,
        runs: getWorkspaceDisplayRuns({
          workspace,
          isViewingLatest: isLatestRunGroup,
        }),
      }))
    }

    if (usingFreshPendingDag) {
      return graph.workspaces.map((path): WorkspaceWithRuns => ({
        preview: {
          id: `pending-${viewedRunGroup.id}-${path}`,
          workspacePath: path,
          status: manualScopeWorkspacePaths !== null && !manualScopeWorkspacePaths.has(path)
            ? "out_of_scope"
            : "pending",
          connectionStatus: "not_required",
          missingProviders: [],
          conflictProviders: [],
          matchedConnections: [],
          blockedReason: null,
          stateKey: "",
          mode: "preview",
          requireApproval: false,
          createdAt: new Date().toISOString(),
        },
        runs: [],
        outputs: null,
      }))
    }

    // Build lookup for workspaces that have runs in this run group
    const wsWithRunsByPath = new Map(
      workspacesWithRuns.map((ws) => [ws.preview.workspacePath, ws])
    )
    
    // Build lookup for all workspaces (to get actual status for those without runs in this group)
    const allWsByPath = new Map(
      workspaces.map((ws) => [ws.preview.workspacePath, ws])
    )

    // Build complete list from dependency graph
    return graph.workspaces.map((path): WorkspaceWithRuns => {
      // If we have run data for this workspace in this run group, use it
      const existing = wsWithRunsByPath.get(path)
      if (existing) {
        return {
          ...existing,
          runs: getWorkspaceDisplayRuns({
            workspace: existing,
            isViewingLatest: isLatestRunGroup,
          }),
        }
      }

      // Check if workspace exists but has no runs in this run group
      // Use its actual status from the full workspaces list
      const fullWs = allWsByPath.get(path)
      if (fullWs) {
        const isOutOfScope = manualScopeWorkspacePaths !== null && !manualScopeWorkspacePaths.has(path)
        return {
          ...fullWs,
          preview: {
            ...fullWs.preview,
            status: isOutOfScope ? "out_of_scope" : fullWs.preview.status,
          },
          runs: getWorkspaceDisplayRuns({
            workspace: {
              ...fullWs,
              preview: {
                ...fullWs.preview,
                status: isOutOfScope ? "out_of_scope" : fullWs.preview.status,
              },
              runs: [],
            },
            isViewingLatest: isLatestRunGroup,
          }),
        }
      }

      // Otherwise, create a placeholder for workspaces not yet created
      const isOutOfScope = manualScopeWorkspacePaths !== null && !manualScopeWorkspacePaths.has(path)
      const placeholder: WorkspacePreview = {
        id: `placeholder-${path}`,
        workspacePath: path,
        status: isOutOfScope ? "out_of_scope" : "pending",
        connectionStatus: "not_required",
        missingProviders: [],
        conflictProviders: [],
        matchedConnections: [],
        blockedReason: null,
        stateKey: "",
        mode: "preview",
        requireApproval: false,
        createdAt: new Date().toISOString(),
      }
      return {
        preview: placeholder,
        runs: [],
        outputs: null,
      }
    })
  })

  const hasCoherentDag = $derived(!!viewedRunGroup && filteredWorkspaces.length > 0)

  // Are we viewing the latest run group or a historical one?
  const isViewingLatest = $derived(isLatestRunGroup)

  const activeEnvironmentLifecycle = $derived(
    isLatestRunGroup ? environmentLifecycle : null,
  )

  const isManualScopedRunGroup = $derived(
    viewedRunGroup?.trigger === "manual" && (viewedRunGroup.selectedWorkspacePaths?.length ?? 0) > 0,
  )

  function getDisplayStatusForWorkspace(workspace: WorkspaceWithRuns): string {
    return getWorkspaceDisplayStatus({
      workspace,
      workspaces: filteredWorkspaces,
      dependencyGraph: viewedRunGroup?.dependencyGraph ?? null,
      isViewingLatest,
    })
  }

  const workspaceDisplayStatuses = $derived.by((): Record<string, string> => {
    const statuses: Record<string, string> = {}

    for (const workspace of filteredWorkspaces) {
      statuses[workspace.preview.workspacePath] = getDisplayStatusForWorkspace(workspace)
    }

    return statuses
  })

  const dagNodeStatuses = $derived.by((): Record<string, string> => {
    const statuses: Record<string, string> = { ...workspaceDisplayStatuses }

    for (const item of activeEnvironmentLifecycle?.items ?? []) {
      statuses[`${item.workspacePath}::${item.phase}::${item.key}`] = item.state
    }

    return statuses
  })

  const previewDag = $derived.by(() => buildPreviewDag({
    workspaces: filteredWorkspaces,
    dependencyGraph: displayDependencyGraph,
    lifecycle: activeEnvironmentLifecycle,
  }))

  const dagNodes = $derived(previewDag.nodes)
  const dagDependencyGraph = $derived(previewDag.dependencyGraph)

  // Helper: check if a workspace has an actively running run group status.
  function isWorkspaceActivelyRunning(ws: WorkspaceWithRuns): boolean {
    const status = workspaceDisplayStatuses[ws.preview.workspacePath] ?? ws.preview.status
    return isWorkspaceActivelyRunningStatus(status)
  }

  // Helper: check if a workspace is part of in-flight work for the viewed run group.
  function isWorkspaceInProgress(ws: WorkspaceWithRuns): boolean {
    const status = workspaceDisplayStatuses[ws.preview.workspacePath] ?? ws.preview.status
    return isWorkspaceInProgressStatus(status)
  }

  const staleStatusWorkspacePaths = $derived.by((): string[] => {
    if (
      !viewedRunGroup
      || !isLatestRunGroup
      || usingFreshPendingDag
      || (viewedRunGroup.status !== "scanning"
        && viewedRunGroup.status !== "pending"
        && viewedRunGroup.status !== "running")
    ) {
      return []
    }

    return filteredWorkspaces
      .filter((workspace) => {
        if (workspace.runs.length > 0) {
          return false
        }

        const status = workspaceDisplayStatuses[workspace.preview.workspacePath] ?? workspace.preview.status
        return status === "failed"
          || status === "cancelled"
          || status === "ready"
          || status === "planned"
      })
      .map((workspace) => workspace.preview.workspacePath)
  })

  // Follow mode: auto-follow the running workspace unless user manually selected one
  // Starts false if there's a ws param in URL (user navigated to specific workspace)
  // Otherwise starts true to follow running workspaces
  const initialWsParam = $page.url.searchParams.get("ws")
  let followMode = $state(!initialWsParam)

  // Track the last run group ID to detect run group changes
  let lastSeenRunGroupId: string | null = null

  // Track the last workspace we followed (to stay on it when nothing is running)
  let lastFollowedPath: string | null = null

  // Get the currently running workspace (for follow mode)
  // Prefer actively running over pending
  const runningWorkspace = $derived.by(() => {
    // First, find a workspace with an actively running run
    const activelyRunning = filteredWorkspaces.find(isWorkspaceActivelyRunning)
    if (activelyRunning) return activelyRunning
    // Fall back to any workspace with pending runs
    return filteredWorkspaces.find(isWorkspaceInProgress) ?? null
  })

  // Is there any workspace in progress? (for showing follow button)
  const hasAnyInProgress = $derived(
    filteredWorkspaces.some(isWorkspaceInProgress)
  )

  // Selected workspace: follows running workspace in follow mode, or respects URL
  let selectedPath = $derived.by(() => {
    const wsParam = $page.url.searchParams.get("ws")
    const nodeFromUrl = dagNodes.find((node) => node.id === wsParam)

    // In follow mode with a running workspace, follow it
    if (followMode && runningWorkspace) {
      return runningWorkspace.preview.workspacePath
    }

    // In follow mode but nothing running - stay on last followed workspace if it exists
    if (followMode && lastFollowedPath) {
      const lastWs = filteredWorkspaces.find((w) => w.preview.workspacePath === lastFollowedPath)
      if (lastWs) {
        return lastFollowedPath
      }
    }

    // Not in follow mode or no valid workspace: use URL param or first workspace
    if (wsParam && nodeFromUrl) {
      return wsParam
    }
    return dagNodes[0]?.id ?? ""
  })

  // Track the last followed workspace when in follow mode
  $effect(() => {
    if (followMode && runningWorkspace) {
      lastFollowedPath = runningWorkspace.preview.workspacePath
    }
  })

  // Re-enable follow mode when switching to a new run group
  // But not if user navigated with a specific workspace in the URL
  $effect(() => {
    const currentRunGroupId = viewedRunGroup?.id ?? null
    const hasWsParam = $page.url.searchParams.has("ws")
    if (currentRunGroupId && currentRunGroupId !== lastSeenRunGroupId) {
      lastSeenRunGroupId = currentRunGroupId
      // Re-enable follow mode and clear last followed path on run group change
      // But respect the URL param if the user navigated to a specific workspace
      if (!hasWsParam) {
        followMode = true
      }
      lastFollowedPath = null
    }
  })

  // Handle workspace selection - disables follow mode
  function handleNodeSelect(path: string) {
    // Disable follow mode when user manually selects
    followMode = false
    pendingWorkspaceSelectionPath = path
    workspaceSelectionStartedAtMs = performance.now()
    const url = new URL($page.url)
    url.searchParams.set("ws", path)
    goto(url.toString(), { replaceState: true, noScroll: true })
  }

  // Re-enable follow mode
  function enableFollowMode() {
    followMode = true
  }

  function focusPanel(nextPanel: PanelFocus): void {
    panelFocus = nextPanel
  }

  function togglePanelFocus(): void {
    panelFocus = panelFocus === "dag" ? "details" : "dag"
  }

  function isTerminalTab(tabId: TabId): boolean {
    return tabId === "plan" || tabId === "apply"
  }

  function preferredSpotlightTab(): TabId | null {
    if (isTerminalTab(activeTab)) {
      return activeTab
    }

    if (latestApply && !applyIsStale) {
      if (latestApply.status === "running" || latestApply.status === "pending") {
        return "apply"
      }
    }

    if (latestPlan?.status === "running") {
      return "plan"
    }

    if (latestApply && !applyIsStale) {
      return "apply"
    }

    if (latestPlan) {
      return "plan"
    }

    return null
  }

  function enterDetailSpotlight(): void {
    focusPanel("details")

    const preferredTab = preferredSpotlightTab()
    if (preferredTab) {
      activeTab = preferredTab
    }

    detailSpotlight = true
  }

  function exitDetailSpotlight(): void {
    detailSpotlight = false
  }

  function toggleDetailSpotlight(): void {
    if (detailSpotlight) {
      exitDetailSpotlight()
      return
    }

    enterDetailSpotlight()
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false
    }

    if (target.classList.contains("xterm-helper-textarea")) {
      return false
    }

    if (target.isContentEditable) {
      return true
    }

    return target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT"
  }

  // Current workspace data (from filtered workspaces)
  const selectedDagNode = $derived(
    dagNodes.find((node) => node.id === selectedPath) ?? null,
  )

  const selectedWorkspace = $derived(
    filteredWorkspaces.find((w) => w.preview.workspacePath === selectedDagNode?.workspacePath)
  )

  const dagColumns = $derived.by((): PreviewDagNode[][] => {
    return computeCliAlignedColumns(
      dagNodes,
      (node: PreviewDagNode) => node.id,
      dagDependencyGraph,
      true,
    ).columns
  })

  const dagNodePositions = $derived.by((): Map<string, { col: number; row: number }> => {
    const positions = new Map<string, { col: number; row: number }>()

    for (const [col, column] of dagColumns.entries()) {
      for (const [row, node] of column.entries()) {
        positions.set(node.id, { col, row })
      }
    }

    return positions
  })

  function selectDagNode(path: string): void {
    focusPanel("dag")
    handleNodeSelect(path)
  }

  function navigateDag(colOffset: number, rowOffset: number): void {
    if (dagColumns.length === 0) {
      return
    }

    const currentPosition = dagNodePositions.get(selectedPath) ?? { col: 0, row: 0 }
    const nextCol = Math.max(0, Math.min(dagColumns.length - 1, currentPosition.col + colOffset))
    const targetColumn = dagColumns[nextCol]

    if (!targetColumn || targetColumn.length === 0) {
      return
    }

    const desiredRow = rowOffset === 0
      ? currentPosition.row
      : currentPosition.row + rowOffset
    const nextRow = Math.max(0, Math.min(targetColumn.length - 1, desiredRow))
    const nextNode = targetColumn[nextRow]

    if (!nextNode || nextNode.id === selectedPath) {
      return
    }

    selectDagNode(nextNode.id)
  }

  function navigateTab(offset: number): void {
    if (tabs.length === 0) {
      return
    }

    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab)
    const nextIndex = currentIndex === -1
      ? 0
      : Math.max(0, Math.min(tabs.length - 1, currentIndex + offset))

    activeTab = tabs[nextIndex].id
  }

  function isShortcutsKey(event: KeyboardEvent): boolean {
    return event.key === "?" || (event.key === "/" && event.shiftKey)
  }

  function closeShortcutsOverlay(): void {
    showShortcutsOverlay = false
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (showShortcutsOverlay) {
      if (event.key === "Escape" || isShortcutsKey(event)) {
        event.preventDefault()
        closeShortcutsOverlay()
      }
      return
    }

    if (detailSpotlight && event.key === "Escape") {
      event.preventDefault()
      exitDetailSpotlight()
      return
    }

    if (
      event.defaultPrevented
      || event.metaKey
      || event.ctrlKey
      || event.altKey
      || isEditableTarget(event.target)
    ) {
      return
    }

    if (isShortcutsKey(event)) {
      event.preventDefault()
      showShortcutsOverlay = true
      return
    }

    if (event.key.toLowerCase() === "z") {
      event.preventDefault()
      toggleDetailSpotlight()
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      if (detailSpotlight) {
        focusPanel("details")
        return
      }
      togglePanelFocus()
      return
    }

    const key = event.key.toLowerCase()

    if (panelFocus === "dag") {
      switch (key) {
        case "h":
          event.preventDefault()
          navigateDag(-1, 0)
          return
        case "j":
          event.preventDefault()
          navigateDag(0, 1)
          return
        case "k":
          event.preventDefault()
          navigateDag(0, -1)
          return
        case "l":
          event.preventDefault()
          navigateDag(1, 0)
          return
        default:
          return
      }
    }

    switch (key) {
      case "h":
        event.preventDefault()
        navigateTab(-1)
        return
      case "l":
        event.preventDefault()
        navigateTab(1)
        return
      default:
        return
    }
  }

  const selectedLifecycleNode = $derived(
    selectedDagNode?.kind === "lifecycle"
      ? selectedDagNode as PreviewLifecycleDagNode
      : null,
  )

  const selectedLifecycleItem = $derived(selectedLifecycleNode?.item ?? null)

  function humanizeLifecycleKey(key: string): string {
    return key
      .replace(/^preview[-_]/, "")
      .replace(/^activation[-_]/, "")
      .replace(/^verification[-_]/, "")
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ") || key
  }

  function lifecyclePhaseLabel(phase: string): string {
    if (phase === "activation") return "Activation Gate"
    if (phase === "verification") return "Verification Gate"
    return "Lifecycle"
  }

  function lifecycleStatusLabel(state: string): string {
    switch (state) {
      case "pending": return "queued"
      case "running": return "in flight"
      case "succeeded": return "passed"
      case "degraded": return "warning"
      case "blocked": return "policy blocked"
      case "failed": return "failed"
      default: return state
    }
  }

  function lifecycleStatusClass(state: string): string {
    switch (state) {
      case "succeeded": return "text-status-ready bg-status-ready/10"
      case "degraded": return "text-status-planning bg-status-planning/10"
      case "blocked": return "text-status-system-error bg-status-system-error/10"
      case "failed": return "text-status-failed bg-status-failed/10"
      case "running": return "text-status-applying bg-status-applying/10"
      default: return "text-text-dim bg-surface-overlay"
    }
  }

  function lifecycleEventLabel(eventType: string): string {
    switch (eventType) {
      case "created": return "Gate armed"
      case "dispatched": return "Sent outward"
      case "dispatch_failed": return "Dispatch failed"
      case "blocked": return "Policy blocked"
      case "callback": return "External result"
      default: return eventType
    }
  }

  function lifecycleEventSummary(event: { eventType: string; payload: Record<string, unknown> }): string {
    if (event.eventType === "callback") {
      const status = typeof event.payload.status === "string"
        ? lifecycleStatusLabel(event.payload.status)
        : "updated"
      const summary = typeof event.payload.summary === "string" ? event.payload.summary : null
      return summary ? `${status}: ${summary}` : status
    }

    if (event.eventType === "blocked") {
      return typeof event.payload.reason === "string"
        ? event.payload.reason
        : "blocked by governance"
    }

    if (event.eventType === "dispatched") {
      return "Yaffle handed the gate to the external system"
    }

    if (event.eventType === "dispatch_failed") {
      return typeof event.payload.reason === "string"
        ? event.payload.reason
        : "the external handoff failed"
    }

    if (event.eventType === "created") {
      return "Yaffle is ready to receive the external ready signal"
    }

    return Object.keys(event.payload).length > 0
      ? JSON.stringify(event.payload)
      : "event recorded"
  }

  function lifecycleNarrative(item: LifecycleItemSummary): string {
    if (item.phase === "verification") {
      return `This gate sits after ${item.workspacePath} and proves the preview is acceptable before you trust it.`
    }

    return `This gate sits after ${item.workspacePath} and turns finished infra into a preview people can actually use.`
  }

  function lifecycleScopeNarrative(item: LifecycleItemSummary): string {
    if (item.scopes.length === 0) {
      return item.phase === "verification"
        ? "Confirms the preview through an external check."
        : "Waits for an external ready signal."
    }

    return item.phase === "verification"
      ? `Confirms ${item.scopes.join(" + ")}.`
      : `Unlocks ${item.scopes.join(" + ")}.`
  }

  const selectedWorkspaceConnectionBlockReason = $derived(
    selectedWorkspace ? getWorkspaceConnectionBlockReason(selectedWorkspace) : null,
  )

  const selectedWorkspaceConnectionBlockLabel = $derived.by((): string | null => {
    if (!selectedWorkspaceConnectionBlockReason) {
      return null
    }

    if (
      selectedWorkspace?.preview.connectionStatus === "conflict"
      || selectedWorkspaceConnectionBlockReason.startsWith("Conflicting connections")
    ) {
      return "resolve connections"
    }

    if (selectedWorkspaceConnectionBlockReason.startsWith("Missing")) {
      return "missing connections"
    }

    if (selectedWorkspace?.preview.degradation) {
      return "metadata degraded"
    }

    return "blocked"
  })

  const selectedWorkspaceBlockedUpstreamPaths = $derived.by((): string[] => {
    if (!selectedWorkspace) {
      return []
    }

    return getBlockingUpstreamWorkspacePaths(
      selectedWorkspace.preview.workspacePath,
      filteredWorkspaces,
      viewedRunGroup?.dependencyGraph ?? null,
    )
  })

  const missingConnectionBlockedWorkspaces = $derived(
    filteredWorkspaces.filter((workspace) => {
      if (workspace.preview.connectionStatus === "missing") {
        return true
      }

      return getWorkspaceConnectionBlockReason(workspace)?.startsWith("Missing connections:") ?? false
    }),
  )

  const missingConnectionProviders = $derived.by((): string[] => {
    const providers = new Set<string>()
    for (const workspace of missingConnectionBlockedWorkspaces) {
      for (const provider of workspace.preview.missingProviders) {
        providers.add(provider)
      }
    }
    return [...providers].sort()
  })

  // Tab state
  type TabId = "plan" | "apply" | "outputs" | "timeline"
  let activeTab = $state<TabId>("plan")
  type PanelFocus = "dag" | "details"
  let panelFocus = $state<PanelFocus>("dag")
  let detailSpotlight = $state(false)
  let showShortcutsOverlay = $state(false)

  // Terminal expanded state - collapsed by default, persisted to localStorage
  const TERMINAL_EXPANDED_KEY = "yaffle:terminal-expanded"
  let terminalExpanded = $state(
    typeof localStorage !== "undefined" && localStorage.getItem(TERMINAL_EXPANDED_KEY) === "true"
  )
  let terminalContainer = $state<HTMLDivElement | null>(null)

  function toggleTerminalExpanded() {
    const expanding = !terminalExpanded
    terminalExpanded = !terminalExpanded
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TERMINAL_EXPANDED_KEY, String(terminalExpanded))
    }
    // When expanding, scroll to keep the bottom of the terminal in view after transition
    if (expanding && terminalContainer) {
      setTimeout(() => {
        terminalContainer?.scrollIntoView({ behavior: "smooth", block: "end" })
      }, 220)
    }
  }
  
  // Cancel state
  let cancellingRunId = $state<string | null>(null)
  let cancelError = $state<string | null>(null)

  // Rerun state
  let rerunning = $state(false)
  let rerunError = $state<string | null>(null)

  // Visible runs for the selected workspace (already filtered by run group)
  const visibleRuns = $derived(selectedWorkspace?.runs ?? [])

  // Get latest plan/apply from the visible (possibly filtered) runs
  const latestPlan = $derived(
    visibleRuns.find((r: Run) => r.runType === "plan") ?? undefined,
  )
  const latestApply = $derived(
    visibleRuns.find((r: Run) => r.runType === "apply") ?? undefined,
  )
  // Show outputs tab if we have outputs to display
  // - From current apply (success or skipped)
  // - Or from workspace's stored outputs (from a previous successful apply)
  const displayOutputs = $derived(
    latestApply?.outputs ?? selectedWorkspace?.outputs
  )
  const hasOutputs = $derived(
    (latestApply?.status === "success" || latestApply?.status === "skipped") ||
    (displayOutputs != null && Object.keys(displayOutputs as object).length > 0)
  )

  // Resource spans from SSE (live, for the currently running run)
  const liveSpans = $derived(selectedWorkspace?.resourceSpans ?? [])

  // Completed run IDs — always lazy-load these so plan spans persist when apply starts
  const completedRunIds = $derived(
    visibleRuns
      .filter((r) => r.status === "success" || r.status === "failed")
      .map((r) => r.id),
  )

  // Timeline tab should show whenever there are runs that could have spans
  const showTimeline = $derived(
    liveSpans.length > 0 || completedRunIds.length > 0 ||
    visibleRuns.some((r) => r.status === "running"),
  )

  // Available tabs based on what data exists
  interface Tab {
    id: TabId
    label: string
    status?: string
  }

  // The apply is stale if it's from a previous run cycle (older than the latest plan)
  const applyIsStale = $derived(
    latestPlan && latestApply && latestApply.createdAt < latestPlan.createdAt,
  )

  const isWorkspaceInFlight = $derived.by((): boolean => {
    const status = selectedWorkspace?.preview.status
    return status === "pending"
      || status === "planning"
      || status === "applying"
      || status === "awaiting_approval"
      || status === "destroying"
  })

  const tabs = $derived.by((): Tab[] => {
    const result: Tab[] = []
    if (showTimeline) {
      result.push({ id: "timeline", label: "Timeline" })
    }
    if (latestPlan) {
      result.push({ id: "plan", label: "Plan", status: latestPlan.status })
    }
    if (latestApply && !applyIsStale) {
      result.push({ id: "apply", label: "Apply", status: latestApply.status })
    }
    if (hasOutputs && !applyIsStale && !isWorkspaceInFlight) {
      result.push({ id: "outputs", label: "Outputs" })
    }
    return result
  })

  // Auto-select tab: switch to apply when plan finishes and apply starts
  $effect(() => {
    if (tabs.length === 0) return
    // Use untrack to read activeTab without creating a dependency on it
    // This prevents infinite loops when we write to activeTab
    const currentTab = untrack(() => activeTab)
    // If current tab isn't available, pick the first one
    if (!tabs.some((t) => t.id === currentTab)) {
      activeTab = tabs[0].id
      return
    }
    // Auto-switch from plan to apply when apply is running/pending
    if (currentTab === "plan" && latestPlan?.status === "success" && latestApply) {
      if (latestApply.status === "running" || latestApply.status === "pending") {
        activeTab = "apply"
      }
    }
  })

  const selectedTerminalRun = $derived.by((): Run | null => {
    if (activeTab === "plan") {
      return latestPlan ?? null
    }

    if (activeTab === "apply") {
      return latestApply ?? null
    }

    return null
  })

  const selectedTerminalRunId = $derived(selectedTerminalRun?.id ?? null)
  const selectedTerminalRunStreaming = $derived(selectedTerminalRun?.status === "running")

  const terminalFallbackOutput = $derived.by(() => {
    if (activeTab === "plan" && latestPlan) {
      return latestPlan.planSummary ?? ""
    }

    return ""
  })

  const runLogStream = useRunLogStream(
    () => selectedTerminalRunId,
    () => selectedTerminalRunStreaming,
    () => runViewCorrelation?.runViewSessionId ?? null,
    () => runViewCorrelation?.pageViewId ?? null,
  )

  const terminalOutput = $derived(
    runLogStream.output || terminalFallbackOutput
  )

  const terminalStreaming = $derived(runLogStream.isStreaming)
  const TERMINAL_STALL_THRESHOLD_MS = 5_000

  let firstDagTelemetrySent = $state(false)
  let firstSelectedWorkspaceTelemetrySent = $state(false)
  let reportedStaleStatusRunGroupIds = $state<string[]>([])
  let lastObservedLatestRunGroupId = $state<string | null>(null)
  let pendingNewRunGroupId = $state<string | null>(null)
  let newRunDetectedAtMs = $state<number | null>(null)
  let pendingWorkspaceSelectionPath = $state<string | null>(null)
  let workspaceSelectionStartedAtMs = $state<number | null>(null)
  let pendingFirstLogByteRunId = $state<string | null>(null)
  let firstLogByteStartedAtMs = $state<number | null>(null)
  let emittedFirstLogByteRunIds = $state<string[]>([])
  let lastLogVisibleAtMs = $state<number | null>(typeof document !== "undefined" ? performance.now() : null)
  let trackedLogRunId = $state<string | null>(null)
  let lastLogConnectionState = $state<typeof runLogStream.connectionState>("idle")
  let hasSeenLogConnected = $state(false)
  let logReconnectCount = $state(0)
  let activeTerminalStallRunId = $state<string | null>(null)
  let terminalStallStartedAtMs = $state<number | null>(null)

  function shouldIgnoreLogVisibilityReconnect(): boolean {
    if (typeof document === "undefined") {
      return true
    }

    if (document.hidden) {
      return true
    }

    return lastLogVisibleAtMs != null && performance.now() - lastLogVisibleAtMs < 1_000
  }

  $effect(() => {
    if (typeof document === "undefined") {
      return
    }

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        lastLogVisibleAtMs = performance.now()
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  })

  $effect(() => {
    if (
      firstDagTelemetrySent
      || !onTrackRunViewEvent
      || runViewStartMs == null
      || !viewedRunGroup
      || !hasCoherentDag
    ) {
      return
    }

    onTrackRunViewEvent({
      name: "run_view_first_dag_rendered",
      runGroupId: viewedRunGroup.id,
      durationMs: performance.now() - runViewStartMs,
      workspaceCount: filteredWorkspaces.length,
      usedPlaceholderDag: usingFreshPendingDag,
    })

    firstDagTelemetrySent = true
  })

  $effect(() => {
    if (!onTrackRunViewEvent || !viewedRunGroup || !selectedWorkspace || !selectedDagNode) {
      return
    }

    const workspacePath = selectedWorkspace.preview.workspacePath

    if (!firstSelectedWorkspaceTelemetrySent && runViewStartMs != null) {
      onTrackRunViewEvent({
        name: "run_view_selected_workspace_rendered",
        runGroupId: viewedRunGroup.id,
        workspacePath,
        durationMs: performance.now() - runViewStartMs,
        selectionSource: "initial",
      })

      firstSelectedWorkspaceTelemetrySent = true
    }

    if (
      pendingWorkspaceSelectionPath === selectedDagNode.id
      && workspaceSelectionStartedAtMs != null
    ) {
      onTrackRunViewEvent({
        name: "run_view_selected_workspace_rendered",
        runGroupId: viewedRunGroup.id,
        workspacePath,
        durationMs: performance.now() - workspaceSelectionStartedAtMs,
        selectionSource: "manual",
      })

      pendingWorkspaceSelectionPath = null
      workspaceSelectionStartedAtMs = null
    }
  })

  $effect(() => {
    if (
      !onTrackRunViewEvent
      || !viewedRunGroup
      || staleStatusWorkspacePaths.length === 0
      || reportedStaleStatusRunGroupIds.includes(viewedRunGroup.id)
    ) {
      return
    }

    onTrackRunViewEvent({
      name: "run_view_stale_status_flash",
      runGroupId: viewedRunGroup.id,
      workspaceCount: filteredWorkspaces.length,
      affectedWorkspaceCount: staleStatusWorkspacePaths.length,
      isVisible: typeof document !== "undefined" ? !document.hidden : undefined,
    })

    reportedStaleStatusRunGroupIds = [...reportedStaleStatusRunGroupIds, viewedRunGroup.id]
  })

  $effect(() => {
    const latestRunGroupId = runGroups[0]?.id ?? null
    if (!latestRunGroupId) {
      return
    }

    if (!lastObservedLatestRunGroupId) {
      lastObservedLatestRunGroupId = latestRunGroupId
      return
    }

    if (latestRunGroupId === lastObservedLatestRunGroupId) {
      return
    }

    lastObservedLatestRunGroupId = latestRunGroupId
    pendingNewRunGroupId = latestRunGroupId
    newRunDetectedAtMs = performance.now()

    onTrackRunViewEvent?.({
      name: "run_view_new_run_detected",
      runGroupId: latestRunGroupId,
    })
  })

  $effect(() => {
    if (
      !onTrackRunViewEvent
      || !pendingNewRunGroupId
      || newRunDetectedAtMs == null
      || runGroups[0]?.id !== pendingNewRunGroupId
      || !hasCoherentDag
    ) {
      return
    }

    onTrackRunViewEvent({
      name: "run_view_new_run_handoff_rendered",
      runGroupId: pendingNewRunGroupId,
      durationMs: performance.now() - newRunDetectedAtMs,
      workspaceCount: filteredWorkspaces.length,
      usedPlaceholderDag: usingFreshPendingDag,
    })

    pendingNewRunGroupId = null
    newRunDetectedAtMs = null
  })

  $effect(() => {
    if (!selectedTerminalRunId || !selectedTerminalRunStreaming) {
      pendingFirstLogByteRunId = null
      firstLogByteStartedAtMs = null
      return
    }

    if (emittedFirstLogByteRunIds.includes(selectedTerminalRunId)) {
      pendingFirstLogByteRunId = null
      firstLogByteStartedAtMs = null
      return
    }

    if (pendingFirstLogByteRunId === selectedTerminalRunId) {
      return
    }

    pendingFirstLogByteRunId = selectedTerminalRunId
    firstLogByteStartedAtMs = performance.now()
  })

  $effect(() => {
    if (
      !onTrackRunViewEvent
      || !pendingFirstLogByteRunId
      || firstLogByteStartedAtMs == null
      || runLogStream.output.length === 0
    ) {
      return
    }

    const emittedRunId = pendingFirstLogByteRunId

    onTrackRunViewEvent({
      name: "run_view_terminal_first_log_byte",
      runGroupId: selectedTerminalRun?.runGroupId ?? null,
      runId: emittedRunId,
      workspacePath: selectedWorkspace?.preview.workspacePath ?? null,
      runType: selectedTerminalRun?.runType ?? null,
      durationMs: performance.now() - firstLogByteStartedAtMs,
    })

    emittedFirstLogByteRunIds = [...emittedFirstLogByteRunIds, emittedRunId]
    pendingFirstLogByteRunId = null
    firstLogByteStartedAtMs = null
  })

  $effect(() => {
    if (selectedTerminalRunId === trackedLogRunId) {
      return
    }

    trackedLogRunId = selectedTerminalRunId
    lastLogConnectionState = runLogStream.connectionState
    hasSeenLogConnected = false
    logReconnectCount = 0
    activeTerminalStallRunId = null
    terminalStallStartedAtMs = null
  })

  $effect(() => {
    const runId = selectedTerminalRunId
    const connectionState = runLogStream.connectionState

    if (runId && selectedTerminalRunStreaming && connectionState === "connected") {
      if (
        hasSeenLogConnected
        && lastLogConnectionState === "disconnected"
        && !shouldIgnoreLogVisibilityReconnect()
      ) {
        logReconnectCount += 1
        onTrackRunViewEvent?.({
          name: "run_view_log_stream_reconnected",
          streamType: "run_log",
          runGroupId: selectedTerminalRun?.runGroupId ?? null,
          runId,
          workspacePath: selectedWorkspace?.preview.workspacePath ?? null,
          runType: selectedTerminalRun?.runType ?? null,
          reconnectCount: logReconnectCount,
          connectionState,
          isVisible: !document.hidden,
        })
      }

      hasSeenLogConnected = true
    }

    lastLogConnectionState = connectionState
  })

  $effect(() => {
    const runId = selectedTerminalRunId
    const lastOutputAtMs = runLogStream.lastOutputAtMs

    if (
      !onTrackRunViewEvent
      || !runId
      || !selectedTerminalRunStreaming
      || runLogStream.connectionState !== "connected"
      || lastOutputAtMs == null
      || typeof document === "undefined"
      || document.hidden
    ) {
      return
    }

    if (activeTerminalStallRunId === runId) {
      return
    }

    const elapsedMs = performance.now() - lastOutputAtMs
    const remainingMs = TERMINAL_STALL_THRESHOLD_MS - elapsedMs

    const startStall = () => {
      if (activeTerminalStallRunId === runId) {
        return
      }

      activeTerminalStallRunId = runId
      terminalStallStartedAtMs = performance.now()

      onTrackRunViewEvent({
        name: "run_view_terminal_stall_started",
        streamType: "run_log",
        runGroupId: selectedTerminalRun?.runGroupId ?? null,
        runId,
        workspacePath: selectedWorkspace?.preview.workspacePath ?? null,
        runType: selectedTerminalRun?.runType ?? null,
        stallThresholdMs: TERMINAL_STALL_THRESHOLD_MS,
        connectionState: runLogStream.connectionState,
        isVisible: !document.hidden,
      })
    }

    if (remainingMs <= 0) {
      startStall()
      return
    }

    const timer = setTimeout(startStall, remainingMs)
    return () => {
      clearTimeout(timer)
    }
  })

  $effect(() => {
    if (
      !onTrackRunViewEvent
      || !activeTerminalStallRunId
      || terminalStallStartedAtMs == null
    ) {
      return
    }

    const runId = selectedTerminalRunId
    const lastOutputAtMs = runLogStream.lastOutputAtMs

    if (
      activeTerminalStallRunId !== runId
      || !selectedTerminalRunStreaming
      || runLogStream.connectionState !== "connected"
    ) {
      activeTerminalStallRunId = null
      terminalStallStartedAtMs = null
      return
    }

    if (lastOutputAtMs != null && lastOutputAtMs > terminalStallStartedAtMs) {
      onTrackRunViewEvent({
        name: "run_view_terminal_stall_ended",
        streamType: "run_log",
        runGroupId: selectedTerminalRun?.runGroupId ?? null,
        runId,
        workspacePath: selectedWorkspace?.preview.workspacePath ?? null,
        runType: selectedTerminalRun?.runType ?? null,
        durationMs: performance.now() - terminalStallStartedAtMs,
        stallThresholdMs: TERMINAL_STALL_THRESHOLD_MS,
        connectionState: runLogStream.connectionState,
        isVisible: !document.hidden,
      })

      activeTerminalStallRunId = null
      terminalStallStartedAtMs = null
    }
  })

  // Get plan JSON for plan summary view
  const planJson = $derived.by(() => {
    // Plan JSON would come from the run, but we need to fetch it separately
    // For now, return null - we'll show terminal output
    return null
  })

  // Standard icons: ✓ ok, ✗ fail, ~ pending, ... in progress, - skipped
  function tabStatusIcon(status?: string): string {
    if (!status) return ""
    switch (status) {
      case "success": return " ✓"
      case "running": return " ..."
      case "pending": return " ~"
      case "failed": return " ✗"
      case "cancelled": return " ✗"
      case "skipped": return " -"
      default: return ""
    }
  }

  function tabStatusColor(status?: string): string {
    if (!status) return ""
    switch (status) {
      case "success": return "text-status-ready"
      case "running": return "text-status-applying"
      case "pending": return "text-status-pending"
      case "failed": return "text-status-failed"
      case "cancelled": return "text-status-failed"
      case "skipped": return "text-text-muted"
      default: return "text-text-muted"
    }
  }

  // Get the currently running run (if any) - check both plan and apply
  const runningRun = $derived.by((): Run | null => {
    if (latestPlan?.status === "running") return latestPlan
    if (latestApply?.status === "running") return latestApply
    return null
  })

  const cancellationPending = $derived(cancellingRunId !== null && runningRun?.id === cancellingRunId)

  $effect(() => {
    if (cancellingRunId && runningRun?.id !== cancellingRunId) {
      cancellingRunId = null
    }
  })

  async function handleCancel() {
    if (!runningRun) return
    
    const runType = runningRun.runType === "apply" ? "apply" : "plan"
    const confirmed = confirm(`Cancel the running ${runType}? This will send SIGINT to terraform for graceful shutdown.`)
    if (!confirmed) return
    
    cancellingRunId = runningRun.id
    cancelError = null
    
    try {
      await cancelRun(runningRun.id)
    } catch (err) {
      cancelError = err instanceof Error ? err.message : "Failed to cancel run"
      cancellingRunId = null
    }
  }

  async function handleRerun() {
    if (!selectedWorkspace) return
    
    rerunning = true
    rerunError = null
    
    try {
      await rerunPreview(selectedWorkspace.preview.id)
      // The SSE stream will update with the new run automatically
    } catch (err) {
      rerunError = err instanceof Error ? err.message : "Failed to start re-run"
    } finally {
      rerunning = false
    }
  }

  // Check if a rerun is possible (no run in progress)
  const canRerun = $derived(!runningRun && selectedWorkspace && !rerunning)

  const selectedWorkspaceDisplayStatus = $derived(
    selectedWorkspace
      ? workspaceDisplayStatuses[selectedWorkspace.preview.workspacePath] ?? selectedWorkspace.preview.status
      : null
  )

  const selectedWorkspaceWaitingLabel = $derived.by((): string => {
    if (selectedWorkspaceConnectionBlockReason) {
      return selectedWorkspaceConnectionBlockLabel === "resolve connections"
        ? "Resolve connections"
        : selectedWorkspaceConnectionBlockLabel === "missing connections"
          ? "Missing connections"
          : "Blocked"
    }

    if (selectedWorkspaceBlockedUpstreamPaths.length > 0) {
      return "Waiting on upstream"
    }

    return statusConfig(selectedWorkspaceDisplayStatus ?? "pending").label
  })

  const selectedWorkspaceWaitingMessage = $derived.by((): string => {
    if (selectedWorkspaceConnectionBlockReason) {
      return `${selectedWorkspaceConnectionBlockReason}. This workspace cannot start until the required connections are configured.`
    }

    if (selectedWorkspaceBlockedUpstreamPaths.length > 0) {
      const label = selectedWorkspaceBlockedUpstreamPaths.length === 1 ? "workspace" : "workspaces"
      return `This workspace is waiting on blocked upstream ${label}: ${selectedWorkspaceBlockedUpstreamPaths.join(", ")}.`
    }

    if (selectedWorkspaceDisplayStatus === "awaiting_approval") {
      return "This workspace is paused and waiting for approval before apply can start."
    }

    if (selectedWorkspaceDisplayStatus === "planning" || selectedWorkspaceDisplayStatus === "applying") {
      return "This workspace is starting up. Live run details will appear as soon as the runner claims work."
    }

    return "This workspace is waiting to be dispatched. It will start once its upstream dependencies complete."
  })

  // Check if the selected workspace is waiting on run-group work without visible runs yet.
  const isQueuedWorkspace = $derived(
    selectedWorkspace
      && selectedWorkspace.runs.length === 0
      && selectedWorkspaceDisplayStatus != null
      && isWorkspaceInProgressStatus(selectedWorkspaceDisplayStatus)
  )

  // Workspace statuses for the run group status badge.
  const workspaceStatusList = $derived(
    filteredWorkspaces.map((workspace) =>
      workspaceDisplayStatuses[workspace.preview.workspacePath] ?? workspace.preview.status
    )
  )

  // Build workspace name matching server-side logic
  function buildWorkspaceName(repoName: string, environment: string, identifier: string, workspacePath: string): string {
    const slugify = (s: string): string =>
      s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    return [slugify(repoName), slugify(environment), slugify(identifier), slugify(workspacePath)].join("-")
  }

  // Generate the backend config block for local tofu usage
  const backendConfig = $derived.by(() => {
    if (!selectedWorkspace) return null
    
    const workspacePath = selectedWorkspace.preview.workspacePath
    let workspaceName: string
    
    if (type === "pr") {
      workspaceName = buildWorkspaceName(repo, "preview", `pr-${identifier}`, workspacePath)
    } else {
      // Branch workspace: uses branch as both environment and identifier
      workspaceName = buildWorkspaceName(repo, String(identifier), String(identifier), workspacePath)
    }
    
    // Use current hostname for the TFC API
    const hostname = typeof window !== "undefined" ? window.location.host : "api.yaffle.dev"
    
    return `# terraform login ${hostname}
terraform {
  cloud {
    hostname     = "${hostname}"
    organization = "${org}"

    workspaces {
      name = "${workspaceName}"
    }
  }
}`
  })

  let copiedBackend = $state(false)
  
  async function handleCopyBackend() {
    if (!backendConfig) return
    
    try {
      await navigator.clipboard.writeText(backendConfig)
      copiedBackend = true
      setTimeout(() => copiedBackend = false, 2000)
    } catch (err) {
      console.error("Failed to copy backend config:", err)
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if showShortcutsOverlay}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <button
      type="button"
      class="absolute inset-0 border-0 bg-black/45 backdrop-blur-md"
      aria-label="Close keyboard shortcuts"
      onclick={closeShortcutsOverlay}
    ></button>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabindex="-1"
      class="relative mx-4 w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-surface/85 shadow-2xl"
    >
      <div class="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-5">
        <div>
          <div class="text-[10px] uppercase tracking-[0.22em] text-text-dim">Keyboard shortcuts</div>
          <div class="mt-2 text-lg font-semibold text-text">Env view controls</div>
          <p class="mt-1 text-sm text-text-dim">
            Panel focus changes what <span class="font-mono text-text">h j k l</span> do.
            <span class="font-mono text-text">Tab</span> flips between the DAG and details, and
            <span class="font-mono text-text">z</span> spotlights the detail pane.
          </p>
        </div>
        <button
          class="rounded border border-border px-2 py-1 text-[11px] uppercase tracking-[0.18em] text-text-dim transition-colors hover:border-yaffle-500/40 hover:text-text"
          onclick={closeShortcutsOverlay}
        >
          esc
        </button>
      </div>

      <div class="grid gap-6 px-6 py-6 md:grid-cols-2">
        <div class="rounded-xl border border-border/70 bg-surface/70 p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-text">DAG focus</div>
              <div class="mt-1 text-xs text-text-dim">Move through columns and rows in the delivery graph.</div>
            </div>
          </div>

          <div class="mt-4 space-y-3 text-sm text-text">
            <div class="flex items-center justify-between gap-4">
              <span>previous column</span>
              <span class="shortcut-key-group"><span class="shortcut-key">h</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>next column</span>
              <span class="shortcut-key-group"><span class="shortcut-key">l</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>row down</span>
              <span class="shortcut-key-group"><span class="shortcut-key">j</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>row up</span>
              <span class="shortcut-key-group"><span class="shortcut-key">k</span></span>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-border/70 bg-surface/70 p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-text">Detail focus</div>
              <div class="mt-1 text-xs text-text-dim">Move between timeline, plan, apply, and outputs.</div>
            </div>
          </div>

          <div class="mt-4 space-y-3 text-sm text-text">
            <div class="flex items-center justify-between gap-4">
              <span>previous detail view</span>
              <span class="shortcut-key-group"><span class="shortcut-key">h</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>next detail view</span>
              <span class="shortcut-key-group"><span class="shortcut-key">l</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>switch panel focus</span>
              <span class="shortcut-key-group"><span class="shortcut-key">Tab</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>toggle detail spotlight</span>
              <span class="shortcut-key-group"><span class="shortcut-key">z</span></span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span>toggle this overlay</span>
              <span class="shortcut-key-group"><span class="shortcut-key">?</span></span>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between gap-4 border-t border-border/70 px-6 py-4 text-xs text-text-dim">
        <span>Active panel: <span class="text-text">{panelFocus}</span></span>
        <span>Use Tab or click inside a panel to focus it.</span>
      </div>
    </div>
  </div>
{/if}

<div class={`flex flex-col overflow-hidden ${detailSpotlight ? "fixed inset-0 z-40 bg-surface" : "h-full"}`}>
  {#if !detailSpotlight}
  <!-- Header -->
  <header class="flex-shrink-0 border-b border-border px-6 py-4">
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-3 mb-1">
          <h1 class="text-lg font-semibold">
            <a 
              href={`${base}/${org}`}
              class="text-text-muted hover:text-yaffle-400 transition-colors"
            >{org}</a><span class="text-text-muted">/</span>{repo}
          </h1>
          {#if type === "pr"}
            <a 
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="text-text-muted hover:text-yaffle-400 transition-colors"
            >
              PR #{identifier}
            </a>
          {:else}
            <RefBadge label={String(identifier)} href={githubTreeUrl({ org, repo }, refName(ref))} />
          {/if}
          <RunGroupStatusBadge statuses={workspaceStatusList} />
          {#if environmentPolicy}
            <span class="text-xs text-yaffle-300 px-1.5 py-0.5 bg-yaffle-500/10 border border-yaffle-500/20 rounded">
              governed env
            </span>
          {/if}
          {#if missingConnectionBlockedWorkspaces.length > 0}
            <ConnectionBlockedBadge
              {org}
              blockedCount={missingConnectionBlockedWorkspaces.length}
              providers={missingConnectionProviders}
              {canManageConnections}
            />
          {/if}
        </div>
        <div class="flex items-center gap-3 text-sm text-text-muted">
          <a
            href={githubTreeUrl({ org, repo }, refName(ref))}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-xs hover:text-yaffle-400 transition-colors"
          >
            {refName(ref)}
          </a>
          <span class="text-text-dim">@</span>
          <a
            href={githubCommitUrl({ org, repo }, viewedRunGroup?.headSha ?? headSha)}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-xs text-text-dim hover:text-yaffle-400 transition-colors"
          >
            {shortSha(viewedRunGroup?.headSha ?? headSha)}
          </a>
          {#if authorLogin}
            <span class="text-text-dim">by</span>
            <a
              href="https://github.com/{authorLogin}"
              target="_blank"
              rel="noopener noreferrer"
              class="text-text-dim hover:text-yaffle-400 transition-colors"
            >
              {authorLogin}
            </a>
          {/if}
        </div>
      </div>
      {#if hasNewerRunGroup && onSwitchToLatest}
        <!-- New run available - show button to switch to it -->
        <button
          onclick={onSwitchToLatest}
          class="flex items-center gap-2 px-3 py-1.5 bg-status-planning/15 hover:bg-status-planning/25 border border-status-planning/30 rounded text-status-planning transition-colors"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 8a6 6 0 0 1 10.2-4.3M14 8a6 6 0 0 1-10.2 4.3" stroke-linecap="round"/>
            <path d="M12 1v3.5h-3.5M4 15v-3.5h3.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="text-left">
            <div class="text-xs font-medium leading-tight">new run</div>
            {#if latestHeadSha}
              <div class="font-mono text-[10px] leading-tight opacity-75">{shortSha(latestHeadSha)}</div>
            {/if}
          </div>
        </button>
      {/if}
    </div>
  </header>
  {/if}

  <!-- Main content -->
  <div class="flex-1 flex flex-col min-h-0">
    {#if filteredWorkspaces.length === 0 && (viewedRunGroup?.status === "scanning" || viewedRunGroup?.status === "pending")}
      <!-- Scanning state: clean centered loading -->
      <div class="flex-1 flex items-center justify-center pt-16">
        <div class="flex flex-col items-center gap-3">
          <svg
            class="w-6 h-6 animate-spin text-yaffle-400"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6" stroke-opacity="0.25"></circle>
            <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"></path>
          </svg>
          <div class="text-center">
            <p class="text-sm font-medium text-text">Scanning workspaces</p>
            <p class="text-xs text-text-dim mt-1">Analyzing dependencies and preparing workspace...</p>
          </div>
        </div>
      </div>
    {:else}
    {#if !detailSpotlight && environmentPolicy}
      <div class="mx-4 mt-4 rounded-lg border border-yaffle-500/20 bg-yaffle-500/8 px-4 py-3">
        <div class="text-sm font-medium text-yaffle-200">Protected environment policy</div>
        <div class="mt-1 text-xs text-text-dim">
          Minimum principal tier: <span class="text-text">{environmentPolicy.minimumPrincipalTier}</span>
          <span class="mx-2 text-text-dim">•</span>
          Lifecycle dispatch: <span class="text-text">{environmentPolicy.lifecycleDispatch}</span>
          <span class="mx-2 text-text-dim">•</span>
          Allowed lifecycle destinations:
          <span class="text-text">{environmentPolicy.allowedDestinationClasses.join(", ")}</span>
        </div>
      </div>
    {/if}
    {#if !detailSpotlight}
      <!-- DAG Visualization (replaces sidebar) -->
      <div
        class={`flex-shrink-0 border-b bg-surface transition-[border-color,box-shadow] ${
          panelFocus === "dag"
            ? "border-yaffle-500/45 ring-1 ring-inset ring-yaffle-500/30"
            : "border-border"
        }`}
        onfocusin={() => focusPanel("dag")}
      >
        <div class="px-4 py-1 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="text-xs text-text-dim font-medium uppercase tracking-wider">Delivery path</span>
            <span class="text-[10px] text-text-dim">infra → activation → verification</span>
            {#if isManualScopedRunGroup}
              <span class="text-[10px] text-text-dim">
                scope: {viewedRunGroup?.selectedWorkspacePaths?.length ?? 0} / {displayDependencyGraph?.workspaces.length ?? filteredWorkspaces.length} workspaces · dim nodes reuse current env state
              </span>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <button
              class="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay hover:bg-yaffle-500/20 text-text-muted hover:text-yaffle-400 transition-colors"
              onclick={() => showShortcutsOverlay = true}
              title="Keyboard shortcuts"
            >
              ?
            </button>
            {#if hasAnyInProgress && !followMode}
              <button
                onclick={enableFollowMode}
                class="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay hover:bg-yaffle-500/20 text-text-muted hover:text-yaffle-400 transition-colors"
                title="Auto-follow running workspace"
              >
                follow
              </button>
            {:else if followMode && hasAnyInProgress}
              <span class="text-[10px] text-yaffle-400" title="Following running workspace">
                following
              </span>
            {/if}
          </div>
        </div>
        <DagVisualization
          nodes={dagNodes}
          dependencyGraph={dagDependencyGraph}
          nodeStatuses={dagNodeStatuses}
          {selectedPath}
          onSelect={selectDagNode}
        />
      </div>
    {/if}

    <!-- Content area -->
    <div
      class={`flex-1 flex flex-col min-w-0 overflow-hidden transition-[border-color,box-shadow] ${
        panelFocus === "details" ? "ring-1 ring-inset ring-yaffle-500/30" : ""
      }`}
      onfocusin={() => focusPanel("details")}
    >
      {#if selectedWorkspace}
        <!-- Workspace header: derive status from the viewed run group -->
        {@const displayStatus = selectedWorkspaceDisplayStatus ?? selectedWorkspace.preview.status}
        {@const cfg = statusConfig(displayStatus)}
        <!-- Workspace header bar -->
        <div class="flex-shrink-0 px-6 py-4 border-b border-border">
          <div class="flex items-center justify-between">
            <div>
              <div class="flex items-center gap-1.5">
                <h2 class="font-mono text-sm text-text">{selectedWorkspace.preview.workspacePath}</h2>
                <button
                  onclick={handleCopyBackend}
                  class="p-1 text-text-dim hover:text-text rounded transition-colors"
                  title="Copy backend configuration"
                >
                  {#if copiedBackend}
                    <svg class="w-3.5 h-3.5 text-status-ready" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="5" y="5" width="8" height="10" rx="1"/>
                      <path d="M3 11V3a1 1 0 0 1 1-1h6"/>
                    </svg>
                  {/if}
                </button>
              </div>
        <div class="flex items-center gap-2 mt-1">
          {#if selectedWorkspaceConnectionBlockReason}
            <span class="text-xs text-status-system-error px-1.5 py-0.5 bg-status-system-error/10 rounded">
              {selectedWorkspaceConnectionBlockLabel}
            </span>
          {:else if selectedWorkspace.preview.connectionStatus !== "missing" && selectedWorkspace.preview.connectionStatus !== "conflict"}
            <span class="text-xs {cfg.color}">{cfg.icon} {cfg.label}</span>
          {/if}
                {#if selectedWorkspace.preview.requireApproval}
                  <span class="text-xs text-status-planning px-1.5 py-0.5 bg-status-planning/10 rounded">
                    requires approval
                  </span>
                {/if}
              </div>
              {#if selectedWorkspaceConnectionBlockReason}
                <div class="mt-2 text-xs text-text-dim">
                  {selectedWorkspaceConnectionBlockReason}
                </div>
              {/if}
              {#if selectedWorkspace.preview.matchedConnections.length > 0}
                <div class="mt-2 text-xs text-text-dim">
                  Using {selectedWorkspace.preview.matchedConnections.map((connection: { name: string }) => connection.name).join(", ")}
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2">
              {#if runningRun}
                <!-- Cancel button for running runs -->
                <button
                  onclick={handleCancel}
                  disabled={cancellingRunId !== null}
                  class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs
                         text-text-muted hover:text-status-failed hover:bg-status-failed/10 
                         rounded transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Cancel running {runningRun.runType}"
                >
                  {#if cancellingRunId === runningRun.id}
                    <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="8" cy="8" r="6" stroke-opacity="0.3"/>
                      <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="8" cy="8" r="6"/>
                      <path d="M6 6l4 4M10 6l-4 4" stroke-linecap="round"/>
                    </svg>
                  {/if}
                  <span>{cancellingRunId === runningRun.id ? "cancelling" : "cancel"}</span>
                </button>
              {:else if canRerun}
                <!-- Run again button for completed runs -->
                <button
                  onclick={handleRerun}
                  disabled={rerunning}
                  class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs
                         text-text-muted hover:text-status-planning hover:bg-status-planning/10 
                         rounded transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Re-run plan and apply"
                >
                  {#if rerunning}
                    <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <circle cx="8" cy="8" r="6" stroke-opacity="0.3"/>
                      <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M2 8a6 6 0 0 1 10.2-4.3M14 8a6 6 0 0 1-10.2 4.3" stroke-linecap="round"/>
                      <path d="M12 1v3.5h-3.5M4 15v-3.5h3.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  {/if}
                  <span>{rerunning ? "starting..." : "run again"}</span>
                </button>
              {/if}
              {#if cancelError}
                <span class="text-xs text-status-failed">{cancelError}</span>
              {/if}
              {#if rerunError}
                <span class="text-xs text-status-failed">{rerunError}</span>
              {/if}
        </div>
      </div>
        </div>

        {#if selectedLifecycleNode && selectedLifecycleItem}
          <div class="mx-6 mt-4 rounded-xl border border-yaffle-500/20 bg-yaffle-500/8 overflow-hidden">
            <div class="px-4 py-3 border-b border-yaffle-500/15 flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-xs text-yaffle-300 px-1.5 py-0.5 bg-yaffle-500/10 rounded whitespace-nowrap">
                  {lifecyclePhaseLabel(selectedLifecycleItem.phase)}
                </span>
                <span class="font-mono text-sm text-text truncate">{humanizeLifecycleKey(selectedLifecycleItem.key)}</span>
                <span class="text-xs px-1.5 py-0.5 rounded whitespace-nowrap {lifecycleStatusClass(selectedLifecycleItem.state)}">
                  {lifecycleStatusLabel(selectedLifecycleItem.state)}
                </span>
              </div>
              <div class="text-[11px] text-text-dim whitespace-nowrap">
                {selectedLifecycleItem.events.length} events
              </div>
            </div>
            <div class="px-4 py-3 border-b border-border/70">
              <div class="text-sm text-text">{lifecycleNarrative(selectedLifecycleItem)}</div>
              <div class="mt-2 text-xs text-text-dim">
                {selectedLifecycleItem.summary ?? selectedLifecycleItem.reason ?? lifecycleScopeNarrative(selectedLifecycleItem)}
              </div>
            </div>
            {#if selectedLifecycleItem.events.length > 0}
              <div class="divide-y divide-border/70">
                {#each selectedLifecycleItem.events as event (event.id)}
                  <div class="px-4 py-3 flex items-start justify-between gap-4">
                    <div>
                      <div class="text-sm text-text">{lifecycleEventLabel(event.eventType)}</div>
                      <div class="mt-1 text-xs text-text-dim">{lifecycleEventSummary(event)}</div>
                    </div>
                    <div class="text-[11px] text-text-dim whitespace-nowrap">{formatRelativeTime(event.createdAt)}</div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="px-4 py-6 text-sm text-text-dim">
                No external results have landed yet.
              </div>
            {/if}
          </div>
        {/if}

        {#if isQueuedWorkspace}
          <div class="flex flex-col items-center justify-center h-48 text-center">
            <svg class="w-10 h-10 text-text-dim/50 mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" stroke-dasharray="4 4"/>
              <path d="M12 6v6l4 2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <p class="text-sm text-text-muted mb-1">{selectedWorkspaceWaitingLabel}</p>
            <p class="text-xs text-text-dim/75 max-w-sm">
              {selectedWorkspaceWaitingMessage}
            </p>
          </div>
        {:else if tabs.length > 0}
          <!-- Tabs subbar -->
          <div class="flex-shrink-0 flex items-center justify-between border-b border-border px-6">
            <div class="flex gap-4">
              {#each tabs as tab (tab.id)}
                <button
                  class="py-2 text-sm font-medium transition-colors border-b-2 -mb-px
                         {activeTab === tab.id 
                           ? 'border-yaffle-500 text-text' 
                           : 'border-transparent text-text-muted hover:text-text'}"
                  onclick={() => {
                    focusPanel("details")
                    activeTab = tab.id
                  }}
                >
                  {tab.label}
                  {#if tab.status}
                    <span class="font-mono text-xs {tabStatusColor(tab.status)}">
                      {tabStatusIcon(tab.status)}
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
            <!-- Expand/collapse button (only show for terminal tabs) -->
            {#if !detailSpotlight && activeTab !== "outputs" && activeTab !== "timeline"}
              <button
                class="p-1.5 text-text-muted hover:text-text transition-colors rounded hover:bg-surface-overlay"
                onclick={toggleTerminalExpanded}
                title={terminalExpanded ? "Collapse terminal" : "Expand terminal"}
              >
                {#if terminalExpanded}
                  <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else}
                  <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            {/if}
          </div>

          <!-- Tab content area -->
          {#if activeTab === "timeline"}
            <div class="flex-1 overflow-auto p-4">
              <ResourceTimeline
                liveSpans={liveSpans}
                completedRunIds={completedRunIds}
                planRunId={latestPlan?.status === "success" ? latestPlan.id : null}
                {streaming}
              />
            </div>
          {:else if activeTab === "outputs" && hasOutputs && !isWorkspaceInFlight}
            <div class="flex-1 overflow-auto p-6">
              <OutputsView outputs={displayOutputs as Record<string, {value: unknown, sensitive?: boolean}> | null} />
            </div>
          {:else if (activeTab === "plan" && latestPlan) || (activeTab === "apply" && latestApply)}
            <!-- Terminal connected directly to tabs bar -->
            {#key `${selectedPath}-${activeTab}-${selectedTerminalRunId ?? "none"}`}
              <div class={`flex flex-col min-h-0 ${detailSpotlight ? "flex-1" : ""}`}>
                {#if runLogStream.error}
                  <div class="px-6 py-2 border-b border-status-failed/20 bg-status-failed/8 text-xs text-status-failed">
                    Live log stream error: {runLogStream.error}
                  </div>
                {/if}
                <div 
                  bind:this={terminalContainer}
                  class={`min-h-0 ${detailSpotlight ? "flex-1" : "transition-all duration-200 ease-in-out"}`}
                  style="height: {detailSpotlight ? '100%' : terminalExpanded ? '500px' : '250px'}"
                >
                  <Terminal output={terminalOutput} streaming={terminalStreaming} />
                </div>
              </div>
            {/key}
          {:else}
            <div class="flex-1 overflow-auto p-6">
              <div class="text-text-dim text-sm text-center py-8">
                No data available for this tab.
              </div>
            </div>
          {/if}
        {/if}
      {:else}
        <div class="flex-1 flex flex-col items-center justify-center text-text-dim gap-2">
          {#if systemError}
            <div class="w-full max-w-4xl px-6 py-8">
              <div class="rounded-xl border border-status-failed/30 bg-status-failed/8 overflow-hidden">
                <div class="px-5 py-4 border-b border-status-failed/20">
                  <div class="flex items-center gap-2 text-status-failed font-medium">
                    <span>✗</span>
                    <span>{systemError.title}</span>
                  </div>
                  <p class="mt-2 text-sm text-text leading-6 whitespace-pre-wrap">{systemError.summary}</p>
                  <div class="mt-2 text-xs text-text-dim font-mono">
                    {systemError.filePath}{#if systemError.line}: {systemError.line}{#if systemError.column}:{systemError.column}{/if}{/if}
                  </div>
                </div>

                {#if systemError.excerpt.length > 0}
                  <div class="overflow-auto bg-surface/70">
                    <pre class="m-0 px-0 py-0 text-sm"><code>
{#each systemError.excerpt as line}
<div class="config-line" class:config-line-highlight={line.highlight}><span class="config-line-number">{line.lineNumber}</span><span class="config-line-content">{line.text || " "}</span></div>
{/each}
                    </code></pre>
                  </div>
                {/if}
              </div>
            </div>
          {:else if filteredWorkspaces.length === 0}
            <svg class="w-12 h-12 text-text-dim/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <p class="text-sm">No runs yet</p>
            <p class="text-xs text-text-dim/75">Runs will appear here when triggered by a push or PR event.</p>
          {:else}
            <p>Select a workspace or gate to inspect the delivery path.</p>
          {/if}
        </div>
      {/if}
    </div>
    {/if}
  </div>
</div>

<style>
  .shortcut-key-group {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .shortcut-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    padding: 0.2rem 0.45rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, white 20%);
    background: color-mix(in srgb, var(--color-surface-overlay) 82%, black 18%);
    color: var(--color-text);
    font-family: "Berkeley Mono", "SFMono-Regular", ui-monospace, monospace;
    font-size: 0.75rem;
    line-height: 1;
  }

  .config-line {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    gap: 0.75rem;
    padding: 0.125rem 1.25rem;
  }

  .config-line-highlight {
    background: color-mix(in srgb, var(--color-status-failed) 12%, transparent);
  }

  .config-line-number {
    color: var(--color-text-dim);
    text-align: right;
    user-select: none;
  }

  .config-line-content {
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "Berkeley Mono", "SFMono-Regular", ui-monospace, monospace;
  }
</style>
