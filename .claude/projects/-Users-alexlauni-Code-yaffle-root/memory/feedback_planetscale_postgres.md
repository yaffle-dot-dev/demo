---
name: PlanetScale is PostgreSQL
description: PlanetScale is being used as a PostgreSQL database, NOT MySQL — stop assuming MySQL
type: feedback
---

PlanetScale is PostgreSQL. Do NOT assume it is MySQL or suggest MySQL migration concerns.

**Why:** User has corrected this multiple times. PlanetScale now offers PostgreSQL, and yaffle uses it as a Postgres-compatible DB. The Drizzle schema uses `pgTable` and PostgreSQL types — no dialect migration needed.

**How to apply:** When PlanetScale is mentioned, treat it as a PostgreSQL database. No schema/dialect changes required for migration.
