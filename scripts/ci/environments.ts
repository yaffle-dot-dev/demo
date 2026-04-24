import { loadYaffleConfig } from "./config"

export async function listNamedEnvironments(): Promise<string[]> {
  const config = await loadYaffleConfig()
  return config.environments.map((environment) => environment.name)
}
