import { CI_COMMAND_SPEC, findCommandSpec, type CommandOptionSpec, type CommandSpec } from "./command-spec"
import { discoverDeployables } from "./deployables/discovery"
import { listNamedEnvironments } from "./environments"

async function resolveValueSource(option: CommandOptionSpec): Promise<string[]> {
  switch (option.valueSource) {
    case "environment-kind":
      return ["named", "transient"]
    case "named-environment":
      return listNamedEnvironments()
    case "deployable":
      return (await discoverDeployables()).map((deployable) => deployable.name)
    case "shell":
      return ["bash", "zsh", "fish"]
    case "github-event":
      return ["push", "pull_request", "pull_request_target"]
    default:
      return []
  }
}

function getCurrentToken(tokens: string[]): string {
  return tokens.length === 0 ? "" : tokens[tokens.length - 1]
}

function getPreviousToken(tokens: string[]): string | undefined {
  return tokens.length < 2 ? undefined : tokens[tokens.length - 2]
}

function walkCommand(tokens: string[]): { spec: CommandSpec; path: string[] } {
  const completedTokens = tokens.slice(0, -1)
  const path: string[] = []
  let current = CI_COMMAND_SPEC
  let index = 0

  while (index < completedTokens.length) {
    const token = completedTokens[index]

    if (token.startsWith("-")) {
      const option = current.options?.find((item) => item.name === token)
      index += option?.takesValue ? 2 : 1
      continue
    }

    const next = current.subcommands?.find((subcommand) => subcommand.name === token)
    if (!next) {
      break
    }

    path.push(token)
    current = next
    index += 1
  }

  return { spec: current, path }
}

function filterMatches(values: string[], currentToken: string): string[] {
  if (!currentToken) {
    return values
  }

  return values.filter((value) => value.startsWith(currentToken))
}

export async function completeCli(tokens: string[]): Promise<string[]> {
  const currentToken = getCurrentToken(tokens)
  const previousToken = getPreviousToken(tokens)
  const { spec, path } = walkCommand(tokens)
  const currentSpec = findCommandSpec(path) ?? spec

  if (previousToken?.startsWith("-")) {
    const option = currentSpec.options?.find((item) => item.name === previousToken)
    if (option?.takesValue) {
      return filterMatches(await resolveValueSource(option), currentToken)
    }
  }

  if (currentToken.startsWith("-")) {
    return filterMatches(currentSpec.options?.map((option) => option.name) ?? [], currentToken)
  }

  const subcommands = (currentSpec.subcommands ?? [])
    .filter((subcommand) => !subcommand.hidden)
    .map((subcommand) => subcommand.name)

  return filterMatches(subcommands, currentToken)
}

export function renderCompletionScript(shell: "bash" | "zsh" | "fish"): string {
  switch (shell) {
    case "bash":
      return `# bash completion for ci
_ci_completion() {
  local cur words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words=("\${COMP_WORDS[@]:1}")
  mapfile -t COMPREPLY < <(ci __complete "\${words[@]}")
}
complete -F _ci_completion ci
`
    case "zsh":
      return `#compdef ci
_ci_completion() {
  local -a args replies
  args=("\${words[@]:2}")
  replies=("\${(@f)$(ci __complete "\${args[@]}")}")
  _describe 'ci completions' replies
}
compdef _ci_completion ci
`
    case "fish":
      return `function __ci_complete
  set -l tokens (commandline -opc)
  set -e tokens[1]
  ci __complete $tokens (commandline -ct)
end
complete -c ci -f -a '(__ci_complete)'
`
  }
}
