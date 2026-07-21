export function canMutateInfrastructure(role: string | null | undefined): boolean {
  return role === "approver" || role === "admin"
}
