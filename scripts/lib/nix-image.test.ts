import { access, readFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { join } from "node:path"

import { vi } from "vitest"

import { afterEach, describe, expect, test } from "@yaffle/test"

const execMock = vi.hoisted(() => vi.fn())

vi.mock("./exec", () => ({
  exec: execMock,
}))

const { pushImageArchive } = await import("./nix-image")

const originalHome = process.env.HOME

afterEach(() => {
  if (originalHome) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("pushImageArchive", () => {
  test("uses an isolated v2 containers registries config for skopeo", async () => {
    process.env.HOME = "/tmp/yaffle-real-home"
    let tempHome = ""
    let registriesConfig = ""

    execMock.mockImplementation(async (_cmd, opts) => {
      tempHome = opts.env.HOME
      registriesConfig = await readFile(
        join(tempHome, ".config", "containers", "registries.conf"),
        "utf8",
      )
      return ""
    })

    await pushImageArchive("/nix/store/image.tar.gz", "registry.example.com/app:sha-test")

    expect(execMock).toHaveBeenCalledOnce()
    expect(execMock).toHaveBeenCalledWith([
      "skopeo",
      "--registries-conf", join(tempHome, ".config", "containers", "registries.conf"),
      "copy",
      "--insecure-policy",
      "--authfile", "/tmp/yaffle-real-home/.docker/config.json",
      "docker-archive:/nix/store/image.tar.gz",
      "docker://registry.example.com/app:sha-test",
    ], {
      env: {
        HOME: tempHome,
      },
    })
    expect(registriesConfig).toContain("unqualified-search-registries")
    expect(registriesConfig).toContain('short-name-mode = "disabled"')
    await expect(access(tempHome, fsConstants.F_OK)).rejects.toThrow()
  })
})
