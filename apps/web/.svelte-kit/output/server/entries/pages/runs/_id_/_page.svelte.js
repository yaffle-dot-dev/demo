import { o as onDestroy } from "../../../../chunks/index-server.js";
import "@sveltejs/kit/internal";
import "../../../../chunks/exports.js";
import "../../../../chunks/utils.js";
import "@sveltejs/kit/internal/server";
import "../../../../chunks/root.js";
import "../../../../chunks/state.svelte.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    onDestroy(() => {
    });
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="text-text-muted text-sm">Loading...</div>`);
    }
    $$renderer2.push(`<!--]-->`);
  });
}
export {
  _page as default
};
