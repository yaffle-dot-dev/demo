import { exec } from "./exec"

const AWS_REGION = process.env.AWS_REGION || "us-east-1"

export interface AwsSessionEnv extends Record<string, string> {
  AWS_ACCESS_KEY_ID: string
  AWS_SECRET_ACCESS_KEY: string
  AWS_SESSION_TOKEN: string
  AWS_REGION: string
}

function printCommandError(err: unknown): void {
  const message = err instanceof Error
    ? err.message.trim()
    : (!err || typeof err !== "object" || !("stderr" in err)
      ? ""
      : typeof err.stderr === "string"
        ? err.stderr.trim()
        : String(err.stderr).trim())

  if (message) {
    console.error(message)
  }
}

export async function assumeRole(
  roleArn: string,
  sessionName: string,
  sourceEnv?: Record<string, string>,
): Promise<AwsSessionEnv> {
  console.log(`Assuming role: ${roleArn}`)

  let output: string
  try {
    output = await exec([
      "aws",
      "sts",
      "assume-role",
      "--role-arn",
      roleArn,
      "--role-session-name",
      sessionName,
      "--duration-seconds",
      "3600",
      "--region",
      AWS_REGION,
    ], {
      env: sourceEnv,
      quiet: true,
      captureStderr: true,
    })
  } catch (err) {
    console.error("[error] aws sts assume-role failed:")
    printCommandError(err)
    throw err
  }

  let result: {
    Credentials: {
      AccessKeyId: string
      SecretAccessKey: string
      SessionToken: string
    }
  }

  try {
    result = JSON.parse(output)
  } catch {
    console.error("[error] Failed to parse aws sts assume-role response:")
    console.error(output)
    throw new Error("Invalid JSON from aws sts assume-role")
  }

  return {
    AWS_ACCESS_KEY_ID: result.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: result.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: result.Credentials.SessionToken,
    AWS_REGION,
  }
}

export function applyAwsSession(session: AwsSessionEnv): void {
  process.env.AWS_ACCESS_KEY_ID = session.AWS_ACCESS_KEY_ID
  process.env.AWS_SECRET_ACCESS_KEY = session.AWS_SECRET_ACCESS_KEY
  process.env.AWS_SESSION_TOKEN = session.AWS_SESSION_TOKEN
  process.env.AWS_REGION = session.AWS_REGION
}
