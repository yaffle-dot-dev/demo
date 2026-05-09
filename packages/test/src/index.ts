import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from "vitest"

declare module "vitest" {
  interface Assertion<T = any> {
    toStartWith(prefix: string): T
  }

  interface AsymmetricMatchersContaining {
    toStartWith(prefix: string): void
  }
}

type MockFactory = typeof vi.fn & {
  module: typeof vi.mock
  restore: () => void
}

const mock = Object.assign(
  ((implementation?: Parameters<typeof vi.fn>[0]) => vi.fn(implementation)) as MockFactory,
  {
    module: vi.mock,
    restore: () => {
      vi.restoreAllMocks()
      vi.resetAllMocks()
    },
  },
)

expect.extend({
  toStartWith(received: string, prefix: string) {
    const pass = typeof received === "string" && received.startsWith(prefix)

    return {
      pass,
      message: () => pass
        ? `expected ${received} not to start with ${prefix}`
        : `expected ${received} to start with ${prefix}`,
    }
  },
})

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  test,
  vi,
}
