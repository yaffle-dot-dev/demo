import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"

import { SSEConnection } from "./connection"
import type { ConnectionState } from "./types"

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type EventHandler = (event: Event | MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  readyState = 0 // CONNECTING
  private listeners = new Map<string, EventHandler[]>()
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: EventHandler): void {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  removeEventListener(type: string, handler: EventHandler): void {
    const handlers = this.listeners.get(type) ?? []
    this.listeners.set(type, handlers.filter((h) => h !== handler))
  }

  close(): void {
    this.closed = true
    this.readyState = 2 // CLOSED
  }

  // Test helpers - simulate server events
  simulateOpen(): void {
    this.readyState = 1 // OPEN
    this.dispatch("open", new Event("open"))
  }

  simulateMessage(data: string): void {
    this.dispatch("update", new MessageEvent("update", { data }))
  }

  simulateError(): void {
    this.dispatch("error", new Event("error"))
  }

  simulateHeartbeat(): void {
    this.dispatch("heartbeat", new MessageEvent("heartbeat", { data: JSON.stringify({ ts: Date.now() }) }))
  }

  private dispatch(type: string, event: Event | MessageEvent): void {
    const handlers = this.listeners.get(type) ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

// ---------------------------------------------------------------------------
// Mock document.hidden & visibility events
// ---------------------------------------------------------------------------

let documentHidden = false
const visibilityListeners: Array<() => void> = []

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

const originalEventSource = globalThis.EventSource
const originalDocument = globalThis.document

beforeEach(() => {
  MockEventSource.instances = []
  documentHidden = false
  visibilityListeners.length = 0

  // @ts-expect-error -- mock global
  globalThis.EventSource = MockEventSource

  // Mock document for visibility API
  // @ts-expect-error -- partial mock
  globalThis.document = {
    get hidden() { return documentHidden },
    addEventListener(type: string, handler: () => void) {
      if (type === "visibilitychange") visibilityListeners.push(handler)
    },
    removeEventListener(type: string, handler: () => void) {
      if (type === "visibilitychange") {
        const idx = visibilityListeners.indexOf(handler)
        if (idx !== -1) visibilityListeners.splice(idx, 1)
      }
    },
  }
})

afterEach(() => {
  globalThis.EventSource = originalEventSource
  // @ts-expect-error -- restore
  globalThis.document = originalDocument
})

function simulateVisibilityChange(hidden: boolean): void {
  documentHidden = hidden
  for (const listener of visibilityListeners) {
    listener()
  }
}

function latestMockES(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEConnection", () => {
  test("connects and transitions to connected state on open", () => {
    const states: ConnectionState[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
    })

    conn.connect()
    expect(states).toEqual(["connecting"])

    latestMockES().simulateOpen()
    expect(states).toEqual(["connecting", "connected"])
  })

  test("delivers parsed messages via onMessage", () => {
    const messages: unknown[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: (data) => messages.push(data),
      onStateChange: () => {},
    })

    conn.connect()
    latestMockES().simulateOpen()

    latestMockES().simulateMessage(JSON.stringify({ data: { id: "1" } }))
    expect(messages).toEqual([{ data: { id: "1" } }])

    latestMockES().simulateMessage(JSON.stringify({ data: { id: "2" } }))
    expect(messages).toEqual([{ data: { id: "1" } }, { data: { id: "2" } }])
  })

  test("calls onError for malformed JSON", () => {
    const errors: Error[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
      onError: (err) => errors.push(err),
    })

    conn.connect()
    latestMockES().simulateOpen()
    latestMockES().simulateMessage("not json{{{")

    expect(errors.length).toBe(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  test("closes EventSource on destroy", () => {
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
    })

    conn.connect()
    const es = latestMockES()
    expect(es.closed).toBe(false)

    conn.destroy()
    expect(es.closed).toBe(true)
  })

  test("does not reconnect after destroy", async () => {
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
    })

    conn.connect()
    conn.destroy()

    const countBefore = MockEventSource.instances.length

    // Simulate error would normally trigger reconnect
    MockEventSource.instances[0].simulateError()

    // Wait for potential reconnect timer
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(MockEventSource.instances.length).toBe(countBefore)
  })

  test("disconnects when tab is hidden", () => {
    const states: ConnectionState[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
    })

    conn.connect()
    latestMockES().simulateOpen()
    expect(states).toEqual(["connecting", "connected"])

    simulateVisibilityChange(true)
    expect(states).toEqual(["connecting", "connected", "disconnected"])
    expect(latestMockES().closed).toBe(true)
  })

  test("reconnects when tab becomes visible", () => {
    const states: ConnectionState[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
    })

    conn.connect()
    const firstES = latestMockES()
    firstES.simulateOpen()

    // Hide tab
    simulateVisibilityChange(true)
    expect(firstES.closed).toBe(true)

    // Show tab
    simulateVisibilityChange(false)
    const secondES = latestMockES()
    expect(secondES).not.toBe(firstES)
    expect(states.includes("connecting")).toBe(true)

    // New connection opens
    secondES.simulateOpen()
    expect(states[states.length - 1]).toBe("connected")

    conn.destroy()
  })

  test("does not reconnect on visibility change after destroy", () => {
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
    })

    conn.connect()
    latestMockES().simulateOpen()
    conn.destroy()

    const countBefore = MockEventSource.instances.length
    simulateVisibilityChange(true)
    simulateVisibilityChange(false)
    expect(MockEventSource.instances.length).toBe(countBefore)
  })

  test("removes visibility listener on destroy", () => {
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
    })

    conn.connect()
    expect(visibilityListeners.length).toBe(1)

    conn.destroy()
    expect(visibilityListeners.length).toBe(0)
  })

  test("reconnects on error with backoff", async () => {
    const states: ConnectionState[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: (s) => states.push(s),
    })

    conn.connect()
    latestMockES().simulateOpen()
    expect(MockEventSource.instances.length).toBe(1)

    // Simulate error
    latestMockES().simulateError()
    expect(states[states.length - 1]).toBe("disconnected")

    // Wait for first backoff (1s)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(MockEventSource.instances.length).toBe(2)
    expect(states[states.length - 1]).toBe("connecting")

    conn.destroy()
  })

  test("resets backoff after successful connection", async () => {
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
    })

    conn.connect()
    latestMockES().simulateOpen()

    // Error -> reconnect after 1s
    latestMockES().simulateError()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(MockEventSource.instances.length).toBe(2)

    // Successful reconnect - should reset backoff
    latestMockES().simulateOpen()

    // Error again -> should reconnect after 1s (not 2s)
    latestMockES().simulateError()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(MockEventSource.instances.length).toBe(3)

    conn.destroy()
  })

  test("ignores events from stale EventSource instances", () => {
    const messages: unknown[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: (data) => messages.push(data),
      onStateChange: () => {},
    })

    conn.connect()
    const firstES = latestMockES()
    firstES.simulateOpen()

    // Hide + show creates a new connection
    simulateVisibilityChange(true)
    simulateVisibilityChange(false)
    const secondES = latestMockES()
    secondES.simulateOpen()

    // Message on old EventSource should be ignored
    firstES.simulateMessage(JSON.stringify({ stale: true }))
    expect(messages.length).toBe(0)

    // Message on new EventSource should be delivered
    secondES.simulateMessage(JSON.stringify({ fresh: true }))
    expect(messages).toEqual([{ fresh: true }])

    conn.destroy()
  })

  test("handles heartbeat events without error", () => {
    const errors: Error[] = []
    const conn = new SSEConnection({
      url: "/test/stream",
      onMessage: () => {},
      onStateChange: () => {},
      onError: (err) => errors.push(err),
    })

    conn.connect()
    latestMockES().simulateOpen()
    latestMockES().simulateHeartbeat()

    expect(errors.length).toBe(0)
    conn.destroy()
  })
})
