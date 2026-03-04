import { Hono } from "hono"

import { createAuthIssuer } from "../lib/openauth.ts"

export const authRoute = new Hono()

authRoute.route("/", createAuthIssuer())
