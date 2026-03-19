<script lang="ts">
  interface Props {
    /** The text to display (branch name, environment name, etc.) */
    label: string
    /** URL to link to (e.g., GitHub tree URL) */
    href: string
  }

  let { label, href }: Props = $props()
</script>

<a
  {href}
  target="_blank"
  rel="noopener noreferrer"
  class="px-2 py-0.5 bg-surface-overlay rounded text-xs text-text-muted hover:text-yaffle-400 transition-colors"
>
  {label}
</a>
