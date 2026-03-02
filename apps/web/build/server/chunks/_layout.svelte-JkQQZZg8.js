function _layout($$renderer, $$props) {
  let { children } = $$props;
  $$renderer.push(`<div class="min-h-screen bg-surface"><nav class="border-b border-border bg-surface-raised"><div class="mx-auto max-w-6xl px-4 py-3 flex items-center gap-6"><a href="/" class="font-mono text-lg font-bold text-yaffle-400 tracking-tight">yaffle</a> <div class="flex gap-4 text-sm text-text-muted"><a href="/" class="hover:text-text transition-colors">Previews</a></div></div></nav> <main class="mx-auto max-w-6xl px-4 py-6">`);
  children($$renderer);
  $$renderer.push(`<!----></main></div>`);
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte-JkQQZZg8.js.map
