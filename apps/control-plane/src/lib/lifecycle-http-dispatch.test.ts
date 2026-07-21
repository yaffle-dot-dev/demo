import { describe, expect, test } from "@yaffle/test"

import {
  isPublicLifecycleAddress,
  postPublicLifecycleWebhook,
  resolvePublicLifecycleDestination,
} from "./lifecycle-http-dispatch.ts"

describe("lifecycle HTTP dispatch", () => {
  test.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicLifecycleAddress(address)).toBe(false)
  })

  test.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicLifecycleAddress(address)).toBe(true)
    },
  )

  test("rejects a destination when any DNS answer is non-public", async () => {
    await expect(
      resolvePublicLifecycleDestination("https://hooks.example.com/lifecycle", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("resolve only to public IP addresses")
  })

  test.each([
    "http://hooks.example.com/lifecycle",
    "https://user:password@hooks.example.com/lifecycle",
    "https://hooks.example.com/lifecycle?token=secret",
    "https://hooks.example.com/lifecycle#fragment",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(
      resolvePublicLifecycleDestination(url, async () => [{ address: "8.8.8.8", family: 4 }]),
    ).rejects.toThrow("public HTTPS URL")
  })

  test("normalizes encoded IP literals before classifying them", async () => {
    await expect(resolvePublicLifecycleDestination("https://0x7f000001/lifecycle")).rejects.toThrow(
      "public IP addresses",
    )
  })

  test("pins the validated address instead of resolving again at connection time", async () => {
    const destination = await resolvePublicLifecycleDestination(
      "https://hooks.example.com/lifecycle",
      async () => [{ address: "8.8.8.8", family: 4 }],
    )
    let connectedAddress = ""

    const status = await postPublicLifecycleWebhook({
      url: "https://hooks.example.com/lifecycle",
      headers: new Headers(),
      body: Buffer.from("{}"),
      destination,
      request: (_url, options, onResponse) => {
        options.lookup?.("hooks.example.com", {}, (_error, address) => {
          connectedAddress = typeof address === "string" ? address : (address[0]?.address ?? "")
        })
        onResponse({ statusCode: 204, resume() {} })
        return {
          setTimeout() {},
          on() {},
          end() {},
          destroy() {},
        }
      },
    })

    expect(status).toBe(204)
    expect(connectedAddress).toBe("8.8.8.8")
  })

  test("returns redirects without following their private location", async () => {
    let requests = 0
    const status = await postPublicLifecycleWebhook({
      url: "https://hooks.example.com/lifecycle",
      headers: new Headers(),
      body: Buffer.from("{}"),
      destination: { address: "8.8.8.8", family: 4 },
      request: (_url, _options, onResponse) => {
        requests += 1
        onResponse({ statusCode: 302, resume() {} })
        return {
          setTimeout() {},
          on() {},
          end() {},
          destroy() {},
        }
      },
    })

    expect(status).toBe(302)
    expect(requests).toBe(1)
  })
})
