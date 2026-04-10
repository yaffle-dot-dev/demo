declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream"

  export interface Header {
    name: string
    type?: string
    [key: string]: unknown
  }

  export type Next = (error?: Error | null) => void

  export interface Extract extends Writable {
    on(event: "entry", listener: (header: Header, stream: Readable, next: Next) => void): this
    on(event: "finish", listener: () => void): this
    on(event: "error", listener: (error: Error) => void): this
  }

  export interface Pack extends Readable {
    entry(header: Header, callback?: Next): Writable
    finalize(): void
  }

  export function extract(): Extract
  export function pack(): Pack
}
