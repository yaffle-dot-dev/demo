import { afterEach, expect, test } from "@yaffle/test"

import {
  deleteStateObject,
  isS3PreconditionFailure,
  StateUploadError,
  uploadState,
} from "./s3-state.ts"

const key = `test-state/${crypto.randomUUID()}.tfstate`
const content = new TextEncoder().encode('{"version":4}')

afterEach(async () => {
  await deleteStateObject(key)
})

test("does not allow a state upload capability to overwrite its object", async () => {
  await uploadState(key, content)

  await expect(uploadState(key, content)).rejects.toMatchObject({
    name: "StateUploadError",
    code: "STATE_ALREADY_UPLOADED",
  } satisfies Partial<StateUploadError>)
})

test("recognizes an S3 write-once precondition failure", () => {
  expect(isS3PreconditionFailure({ $metadata: { httpStatusCode: 412 } })).toBe(true)
  expect(isS3PreconditionFailure({ $metadata: { httpStatusCode: 500 } })).toBe(false)
})
