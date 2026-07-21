import type { OrgInfo } from "$lib/api"

const ORG_LIST_CHANGED_EVENT = "yaffle:org-list-changed"

export function notifyOrgListChanged(orgs?: OrgInfo[]): void {
  if (typeof window === "undefined") return

  window.dispatchEvent(
    new CustomEvent(ORG_LIST_CHANGED_EVENT, {
      detail: { orgs },
    }),
  )
}

export function onOrgListChanged(handler: (orgs?: OrgInfo[]) => void): () => void {
  if (typeof window === "undefined") {
    return () => {}
  }

  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<{ orgs?: OrgInfo[] }>
    handler(customEvent.detail?.orgs)
  }

  window.addEventListener(ORG_LIST_CHANGED_EVENT, listener)
  return () => window.removeEventListener(ORG_LIST_CHANGED_EVENT, listener)
}
