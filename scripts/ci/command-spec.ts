export interface CommandOptionSpec {
  name: string
  takesValue?: boolean
  valueSource?: "environment-kind" | "named-environment" | "deployable" | "shell" | "github-event"
}

export interface CommandSpec {
  name: string
  hidden?: boolean
  options?: CommandOptionSpec[]
  subcommands?: CommandSpec[]
}

export const CI_COMMAND_SPEC: CommandSpec = {
  name: "ci",
  subcommands: [
    {
      name: "target",
      subcommands: [
        {
          name: "create",
          options: [
            { name: "--kind", takesValue: true, valueSource: "environment-kind" },
            { name: "--environment", takesValue: true, valueSource: "named-environment" },
            { name: "--sha", takesValue: true },
            { name: "--base-sha", takesValue: true },
            { name: "--ref", takesValue: true },
            { name: "--branch", takesValue: true },
            { name: "--pr", takesValue: true },
            { name: "--out", takesValue: true },
          ],
        },
        {
          name: "resolve",
          options: [
            { name: "--github-event-name", takesValue: true, valueSource: "github-event" },
            { name: "--github-event-path", takesValue: true },
            { name: "--github-ref", takesValue: true },
            { name: "--github-sha", takesValue: true },
            { name: "--out", takesValue: true },
          ],
        },
      ],
    },
    {
      name: "deployables",
      subcommands: [
        {
          name: "list",
          options: [
            { name: "--json" },
            { name: "--environment-kind", takesValue: true, valueSource: "environment-kind" },
          ],
        },
        {
          name: "detect",
          options: [
            { name: "--target", takesValue: true },
            { name: "--all" },
            { name: "--json" },
            { name: "--deployable", takesValue: true, valueSource: "deployable" },
          ],
        },
      ],
    },
    {
      name: "secrets",
      subcommands: [
        {
          name: "ensure",
          options: [
            { name: "--target", takesValue: true },
            { name: "--all" },
            { name: "--json" },
            { name: "--deployable", takesValue: true, valueSource: "deployable" },
          ],
        },
        {
          name: "check",
          options: [
            { name: "--target", takesValue: true },
            { name: "--all" },
            { name: "--json" },
            { name: "--deployable", takesValue: true, valueSource: "deployable" },
          ],
        },
      ],
    },
    {
      name: "environments",
      subcommands: [
        {
          name: "list",
          options: [{ name: "--json" }],
        },
      ],
    },
    {
      name: "env",
      subcommands: [
        {
          name: "converge",
          options: [
            { name: "--target", takesValue: true },
            { name: "--all" },
            { name: "--json" },
            { name: "--dry-run" },
            { name: "--deployable", takesValue: true, valueSource: "deployable" },
          ],
        },
      ],
    },
    {
      name: "completion",
      subcommands: [
        { name: "bash" },
        { name: "zsh" },
        { name: "fish" },
      ],
    },
    {
      name: "__complete",
      hidden: true,
    },
  ],
}

export function findCommandSpec(path: string[]): CommandSpec | undefined {
  let current: CommandSpec | undefined = CI_COMMAND_SPEC

  for (const segment of path) {
    current = current.subcommands?.find((subcommand) => subcommand.name === segment)
    if (!current) {
      return undefined
    }
  }

  return current
}
