export const SHARED_OUTPUT_SNAPSHOT_CONTRACT_VERSION = 1 as const

declare const environmentNameBrand: unique symbol
declare const publicationVersionBrand: unique symbol
declare const stateSerialBrand: unique symbol
declare const stateVersionIdentityBrand: unique symbol

export type EnvironmentName = string & {
  readonly [environmentNameBrand]: true
}

export function environmentName(name: string): EnvironmentName {
  if (!name.trim()) {
    throw new Error("Environment name must not be empty")
  }

  return name as EnvironmentName
}

export type PublicationVersion = number & {
  readonly [publicationVersionBrand]: true
}

export function publicationVersion(version: number): PublicationVersion {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("Publication version must be a positive safe integer")
  }

  return version as PublicationVersion
}

export type StateSerial = number & {
  readonly [stateSerialBrand]: true
}

export function stateSerial(serial: number): StateSerial {
  if (!Number.isSafeInteger(serial) || serial < 0) {
    throw new Error("State serial must be a non-negative safe integer")
  }

  return serial as StateSerial
}

export type StateVersionIdentity = `statev_${string}` & {
  readonly [stateVersionIdentityBrand]: true
}

export function stateVersionIdentity(identity: string): StateVersionIdentity {
  if (!/^statev_[A-Za-z0-9]+$/.test(identity)) {
    throw new Error("State identity must be an opaque statev_ identifier")
  }

  return identity as StateVersionIdentity
}

export type EnvironmentClass =
  | "transient_managed"
  | "named_managed"
  | "named_external"
  | "static_external"

export type EnvironmentIdentity =
  | { class: "transient_managed"; name: EnvironmentName }
  | { class: "named_managed"; name: EnvironmentName }
  | { class: "named_external"; name: EnvironmentName }
  | { class: "static_external" }

export interface SharedOutputProducer {
  organizationId: string
  organization: string
  repositoryId: string
  repository: string
  workspace: string
  environment: EnvironmentIdentity
}

export interface GitSourceRevision {
  vcs: "git"
  commitSha: string
  ref?: string
}

export interface TerraformStateIdentity {
  /** Opaque Yaffle identity. Never expose a backend URL or state key here. */
  identity: StateVersionIdentity
  serial: StateSerial
}

export type SharedOutputValue =
  | { value: unknown; sensitive: false }
  | { value: null; sensitive: true }

/** Immutable, provenance-bearing handoff from a shared infrastructure producer. */
export interface SharedOutputSnapshotV1 {
  contractVersion: typeof SHARED_OUTPUT_SNAPSHOT_CONTRACT_VERSION
  snapshotId: string
  publicationVersion: PublicationVersion
  producer: SharedOutputProducer
  sourceRevision: GitSourceRevision
  state: TerraformStateIdentity
  publishedAt: string
  values: Record<string, SharedOutputValue>
}
