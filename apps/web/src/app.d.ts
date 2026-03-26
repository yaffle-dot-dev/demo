// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // Build-time constants injected by Vite
  const __BUILD_SHA__: string
  const __BUILD_TIME__: string
}

export {}

interface ImportMetaEnv {
  readonly VITE_YAFFLE_API_URL?: string
  readonly VITE_STRIPE_PRO_PRICE_ID?: string
  readonly VITE_STRIPE_PRO_AMOUNT?: string
  readonly VITE_STRIPE_TEAM_PRICE_ID?: string
  readonly VITE_STRIPE_TEAM_AMOUNT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
