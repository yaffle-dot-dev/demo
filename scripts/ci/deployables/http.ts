export interface VerifyUrlOptions {
  label: string
  url: string
  expectedStatus?: number
  attempts?: number
  delayMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function verifyUrl(options: VerifyUrlOptions): Promise<void> {
  const attempts = options.attempts ?? 12
  const delayMs = options.delayMs ?? 5000
  const expectedStatus = options.expectedStatus ?? 200

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(options.url, {
        redirect: "follow",
      })

      if (response.status === expectedStatus) {
        console.log(`Verified ${options.label}: ${options.url}`)
        return
      }

      console.log(
        `${options.label} verification attempt ${attempt}/${attempts} returned ${response.status}`,
      )
    } catch (error) {
      console.log(
        `${options.label} verification attempt ${attempt}/${attempts} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }

  throw new Error(`Failed to verify ${options.label} at ${options.url}`)
}
