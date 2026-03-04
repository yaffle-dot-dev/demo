<script lang="ts">
  import { onMount, onDestroy } from "svelte"
  import { browser } from "$app/environment"

  interface Props {
    output?: string
    streaming?: boolean
  }

  let props: Props = $props()

  const output = $derived(props.output ?? "")
  const streaming = $derived(props.streaming ?? false)

  let container: HTMLDivElement
  let term = $state<import("xterm").Terminal | null>(null)
  let fitAddon: import("@xterm/addon-fit").FitAddon | null = null
  let resizeObserver: ResizeObserver | null = null
  let lastOutput = ""

  // Buffer for streaming mode - batch writes for performance
  let writeBuffer = ""
  let writeTimeout: ReturnType<typeof setTimeout> | null = null

  onMount(async () => {
    if (!browser) return

    // Dynamic imports to avoid SSR issues
    const { Terminal } = await import("xterm")
    const { FitAddon } = await import("@xterm/addon-fit")
    const { WebLinksAddon } = await import("@xterm/addon-web-links")

    // Import CSS
    await import("xterm/css/xterm.css")

    term = new Terminal({
      theme: {
        background: "#18181b", // surface-raised
        foreground: "#fafafa", // text
        cursor: "#0c8eeb", // yaffle-500
        cursorAccent: "#18181b",
        selectionBackground: "#27272a", // surface-overlay
        selectionForeground: "#fafafa",
        black: "#09090b",
        red: "#ef4444", // status-failed
        green: "#22c55e", // status-ready
        yellow: "#facc15", // status-planning
        blue: "#3b82f6", // status-applying
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#fafafa",
        brightBlack: "#71717a", // text-dim
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fde047",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: 10000,
      convertEol: true,
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: true,
    })

    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())

    term.open(container)
    fitAddon.fit()

    // Resize on container size change
    resizeObserver = new ResizeObserver(() => {
      fitAddon?.fit()
    })
    resizeObserver.observe(container)

    // Write initial output if present
    if (output) {
      term.write(output)
      lastOutput = output
    }
  })

  // Handle output changes
  $effect(() => {
    if (!term || !browser) return

    if (streaming) {
      // In streaming mode, append only new content if this looks like a continuation
      // (output starts with lastOutput AND lastOutput is non-empty)
      if (lastOutput && output.startsWith(lastOutput)) {
        const newContent = output.slice(lastOutput.length)
        if (newContent) {
          // Buffer writes for performance
          writeBuffer += newContent
          if (!writeTimeout) {
            writeTimeout = setTimeout(() => {
              if (term && writeBuffer) {
                term.write(writeBuffer)
                writeBuffer = ""
              }
              writeTimeout = null
            }, 50)
          }
        }
        lastOutput = output
      } else if (output !== lastOutput) {
        // Content changed completely (different workspace or fresh data), rewrite
        writeBuffer = ""
        if (writeTimeout) {
          clearTimeout(writeTimeout)
          writeTimeout = null
        }
        term.clear()
        term.write(output)
        lastOutput = output
      }
    } else {
      // Non-streaming mode: replace content if different
      if (output !== lastOutput) {
        term.clear()
        term.write(output)
        lastOutput = output
      }
    }
  })

  onDestroy(() => {
    if (writeTimeout) clearTimeout(writeTimeout)
    resizeObserver?.disconnect()
    term?.dispose()
  })

  export function scrollToBottom() {
    term?.scrollToBottom()
  }

  export function clear() {
    term?.clear()
    lastOutput = ""
  }
</script>

<div bind:this={container} class="h-full w-full min-h-[200px] rounded-lg overflow-hidden"></div>

<style>
  :global(.xterm) {
    padding: 12px;
  }

  :global(.xterm-viewport) {
    border-radius: 8px;
  }
</style>
