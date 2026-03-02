import { e as escape_html, a as attr, b as ensure_array_like, s as stringify, c as attr_class, d as derived } from "../../chunks/index.js";
import { o as onDestroy } from "../../chunks/index-server.js";
const STATUS_CONFIG = {
  pending: { label: "Pending", color: "text-status-pending", icon: "~" },
  planning: { label: "Planning", color: "text-status-planning", icon: "..." },
  applying: { label: "Applying", color: "text-status-applying", icon: ">" },
  ready: { label: "Ready", color: "text-status-ready", icon: "+" },
  failed: { label: "Failed", color: "text-status-failed", icon: "!" },
  destroying: { label: "Destroying", color: "text-status-destroying", icon: "<" },
  destroyed: { label: "Destroyed", color: "text-status-destroyed", icon: "x" }
};
function statusConfig(status) {
  return STATUS_CONFIG[status] ?? { label: status, color: "text-text-muted", icon: "?" };
}
function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = /* @__PURE__ */ new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1e3);
  if (diffSeconds < 60) return "just now";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}
function shortSha(sha) {
  return sha.slice(0, 7);
}
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let org = "lamalex";
    let repoFilter = "";
    let showInactive = false;
    let yourHandle = "";
    let previews = [];
    const ACTIVE_STATUSES = /* @__PURE__ */ new Set(["pending", "planning", "applying", "ready", "failed"]);
    function statusPriority(status) {
      switch (status) {
        case "failed":
          return 5;
        case "applying":
          return 4;
        case "planning":
          return 3;
        case "pending":
          return 2;
        case "ready":
          return 1;
        case "destroying":
          return 0;
        case "destroyed":
          return -1;
        default:
          return -2;
      }
    }
    function groupPreviews(list) {
      const map = /* @__PURE__ */ new Map();
      for (const preview of list) {
        const key = `${preview.repo}#${preview.prNumber}`;
        const existing = map.get(key);
        const createdAt = existing ? new Date(existing.createdAt) > new Date(preview.createdAt) ? existing.createdAt : preview.createdAt : preview.createdAt;
        const status = existing ? statusPriority(preview.status) > statusPriority(existing.status) ? preview.status : existing.status : preview.status;
        const headSha = existing?.headSha ?? preview.headSha;
        const branch = existing?.branch ?? preview.branch;
        const authorLogin = existing?.authorLogin ?? preview.authorLogin ?? null;
        const group = {
          key,
          repo: preview.repo,
          prNumber: preview.prNumber,
          branch,
          headSha,
          createdAt,
          status,
          authorLogin,
          workspaces: existing ? [...existing.workspaces, preview] : [preview]
        };
        map.set(key, group);
      }
      return Array.from(map.values()).sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    }
    const activeGroups = derived(() => groupPreviews(previews.filter((p) => ACTIVE_STATUSES.has(p.status))));
    const normalizedHandle = derived(() => yourHandle.trim().toLowerCase());
    const yourGroups = derived(() => normalizedHandle() ? activeGroups().filter((g) => (g.authorLogin ?? "").toLowerCase() === normalizedHandle()) : []);
    const otherGroups = derived(() => normalizedHandle() ? activeGroups().filter((g) => (g.authorLogin ?? "").toLowerCase() !== normalizedHandle()) : activeGroups());
    onDestroy(() => {
    });
    $$renderer2.push(`<div class="space-y-6"><section class="rounded-xl border border-border bg-gradient-to-br from-surface-raised via-surface to-surface px-5 py-4"><div class="flex items-center justify-between"><div><h1 class="text-xl font-semibold">Preview groups</h1> <p class="text-sm text-text-muted mt-1">Active previews grouped by PR. Destroyed previews are hidden by default.</p></div> <div class="text-right text-sm text-text-dim"><div class="font-mono text-xs">${escape_html(activeGroups().length)} groups</div> <div class="font-mono text-xs">${escape_html(previews.length)} workspaces</div></div></div></section> <div class="flex flex-wrap gap-3 items-center"><input type="text"${attr("value", org)} placeholder="org" class="bg-surface-raised border border-border rounded px-3 py-1.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-36"/> <input type="text"${attr("value", repoFilter)} placeholder="repo" class="bg-surface-raised border border-border rounded px-3 py-1.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-52"/> <input type="text"${attr("value", yourHandle)} placeholder="your handle" class="bg-surface-raised border border-border rounded px-3 py-1.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:border-yaffle-500 w-40"/> <label class="flex items-center gap-2 text-sm text-text-muted"><input type="checkbox"${attr("checked", showInactive, true)}/> Show destroyed</label></div> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (activeGroups().length === 0) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<div class="text-text-dim text-sm py-10 text-center">Waiting for your first preview or deployment.</div>`);
    } else {
      $$renderer2.push("<!--[!-->");
      if (normalizedHandle()) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<section class="space-y-3"><div class="flex items-center justify-between"><h2 class="text-sm font-medium text-text-muted">Your active previews</h2> <span class="text-xs text-text-dim">${escape_html(yourGroups().length)} groups</span></div> `);
        if (yourGroups().length === 0) {
          $$renderer2.push("<!--[-->");
          $$renderer2.push(`<div class="text-text-dim text-sm py-6 text-center">No previews for @${escape_html(normalizedHandle())}.</div>`);
        } else {
          $$renderer2.push("<!--[!-->");
          $$renderer2.push(`<div class="grid grid-cols-1 gap-4"><!--[-->`);
          const each_array = ensure_array_like(yourGroups());
          for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
            let group = each_array[$$index_1];
            const cfg = statusConfig(group.status);
            $$renderer2.push(`<div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors"><div class="flex items-start justify-between"><div><div class="flex items-center gap-3"><a${attr("href", `/previews/${stringify(group.workspaces[0].id)}`)} class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">${escape_html(group.repo)}</a> <span class="font-mono text-sm text-text-muted">#${escape_html(group.prNumber)}</span> <span${attr_class(`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${stringify(cfg.color)} bg-surface-overlay`)}><span class="font-mono">${escape_html(cfg.icon)}</span> ${escape_html(cfg.label)}</span></div> <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2"><span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">${escape_html(group.branch)}</span> <span class="font-mono text-xs text-text-dim">${escape_html(shortSha(group.headSha))}</span> <span class="text-text-dim text-xs">${escape_html(formatRelativeTime(group.createdAt))}</span></div></div> <div class="text-right text-xs text-text-dim">${escape_html(group.workspaces.length)} workspace${escape_html(group.workspaces.length === 1 ? "" : "s")}</div></div> <div class="mt-4 flex flex-wrap gap-2"><!--[-->`);
            const each_array_1 = ensure_array_like(group.workspaces);
            for (let $$index = 0, $$length2 = each_array_1.length; $$index < $$length2; $$index++) {
              let ws = each_array_1[$$index];
              const wsCfg = statusConfig(ws.status);
              $$renderer2.push(`<a${attr("href", `/previews/${stringify(ws.id)}`)} class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors"><span${attr_class(`font-mono text-[10px] ${stringify(wsCfg.color)}`)}>${escape_html(wsCfg.icon)}</span> <span class="font-mono">${escape_html(ws.workspacePath)}</span></a>`);
            }
            $$renderer2.push(`<!--]--></div></div>`);
          }
          $$renderer2.push(`<!--]--></div>`);
        }
        $$renderer2.push(`<!--]--></section> <section class="space-y-3"><div class="flex items-center justify-between"><h2 class="text-sm font-medium text-text-muted">Other active previews</h2> <span class="text-xs text-text-dim">${escape_html(otherGroups().length)} groups</span></div> `);
        if (otherGroups().length === 0) {
          $$renderer2.push("<!--[-->");
          $$renderer2.push(`<div class="text-text-dim text-sm py-6 text-center">No other active previews.</div>`);
        } else {
          $$renderer2.push("<!--[!-->");
          $$renderer2.push(`<div class="grid grid-cols-1 gap-4"><!--[-->`);
          const each_array_2 = ensure_array_like(otherGroups());
          for (let $$index_3 = 0, $$length = each_array_2.length; $$index_3 < $$length; $$index_3++) {
            let group = each_array_2[$$index_3];
            const cfg = statusConfig(group.status);
            $$renderer2.push(`<div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors"><div class="flex items-start justify-between"><div><div class="flex items-center gap-3"><a${attr("href", `/previews/${stringify(group.workspaces[0].id)}`)} class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">${escape_html(group.repo)}</a> <span class="font-mono text-sm text-text-muted">#${escape_html(group.prNumber)}</span> <span${attr_class(`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${stringify(cfg.color)} bg-surface-overlay`)}><span class="font-mono">${escape_html(cfg.icon)}</span> ${escape_html(cfg.label)}</span></div> <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2"><span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">${escape_html(group.branch)}</span> <span class="font-mono text-xs text-text-dim">${escape_html(shortSha(group.headSha))}</span> <span class="text-text-dim text-xs">${escape_html(formatRelativeTime(group.createdAt))}</span> `);
            if (group.authorLogin) {
              $$renderer2.push("<!--[-->");
              $$renderer2.push(`<span class="text-text-dim text-xs">@${escape_html(group.authorLogin)}</span>`);
            } else {
              $$renderer2.push("<!--[!-->");
            }
            $$renderer2.push(`<!--]--></div></div> <div class="text-right text-xs text-text-dim">${escape_html(group.workspaces.length)} workspace${escape_html(group.workspaces.length === 1 ? "" : "s")}</div></div> <div class="mt-4 flex flex-wrap gap-2"><!--[-->`);
            const each_array_3 = ensure_array_like(group.workspaces);
            for (let $$index_2 = 0, $$length2 = each_array_3.length; $$index_2 < $$length2; $$index_2++) {
              let ws = each_array_3[$$index_2];
              const wsCfg = statusConfig(ws.status);
              $$renderer2.push(`<a${attr("href", `/previews/${stringify(ws.id)}`)} class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors"><span${attr_class(`font-mono text-[10px] ${stringify(wsCfg.color)}`)}>${escape_html(wsCfg.icon)}</span> <span class="font-mono">${escape_html(ws.workspacePath)}</span></a>`);
            }
            $$renderer2.push(`<!--]--></div></div>`);
          }
          $$renderer2.push(`<!--]--></div>`);
        }
        $$renderer2.push(`<!--]--></section>`);
      } else {
        $$renderer2.push("<!--[!-->");
        $$renderer2.push(`<div class="grid grid-cols-1 gap-4"><!--[-->`);
        const each_array_4 = ensure_array_like(activeGroups());
        for (let $$index_5 = 0, $$length = each_array_4.length; $$index_5 < $$length; $$index_5++) {
          let group = each_array_4[$$index_5];
          const cfg = statusConfig(group.status);
          $$renderer2.push(`<div class="rounded-lg border border-border bg-surface-raised p-4 hover:border-yaffle-500/40 transition-colors"><div class="flex items-start justify-between"><div><div class="flex items-center gap-3"><a${attr("href", `/previews/${stringify(group.workspaces[0].id)}`)} class="text-lg font-medium text-text hover:text-yaffle-400 transition-colors">${escape_html(group.repo)}</a> <span class="font-mono text-sm text-text-muted">#${escape_html(group.prNumber)}</span> <span${attr_class(`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${stringify(cfg.color)} bg-surface-overlay`)}><span class="font-mono">${escape_html(cfg.icon)}</span> ${escape_html(cfg.label)}</span></div> <div class="flex flex-wrap gap-4 text-sm text-text-muted mt-2"><span class="font-mono text-xs bg-surface-overlay px-1.5 py-0.5 rounded">${escape_html(group.branch)}</span> <span class="font-mono text-xs text-text-dim">${escape_html(shortSha(group.headSha))}</span> <span class="text-text-dim text-xs">${escape_html(formatRelativeTime(group.createdAt))}</span> `);
          if (group.authorLogin) {
            $$renderer2.push("<!--[-->");
            $$renderer2.push(`<span class="text-text-dim text-xs">@${escape_html(group.authorLogin)}</span>`);
          } else {
            $$renderer2.push("<!--[!-->");
          }
          $$renderer2.push(`<!--]--></div></div> <div class="text-right text-xs text-text-dim">${escape_html(group.workspaces.length)} workspace${escape_html(group.workspaces.length === 1 ? "" : "s")}</div></div> <div class="mt-4 flex flex-wrap gap-2"><!--[-->`);
          const each_array_5 = ensure_array_like(group.workspaces);
          for (let $$index_4 = 0, $$length2 = each_array_5.length; $$index_4 < $$length2; $$index_4++) {
            let ws = each_array_5[$$index_4];
            const wsCfg = statusConfig(ws.status);
            $$renderer2.push(`<a${attr("href", `/previews/${stringify(ws.id)}`)} class="inline-flex items-center gap-2 px-2 py-1 rounded border border-border-subtle bg-surface text-xs text-text-muted hover:text-text transition-colors"><span${attr_class(`font-mono text-[10px] ${stringify(wsCfg.color)}`)}>${escape_html(wsCfg.icon)}</span> <span class="font-mono">${escape_html(ws.workspacePath)}</span></a>`);
          }
          $$renderer2.push(`<!--]--></div></div>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
export {
  _page as default
};
