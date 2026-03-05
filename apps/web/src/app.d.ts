// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {}

interface ImportMetaEnv {
  readonly VITE_YAFFLE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
