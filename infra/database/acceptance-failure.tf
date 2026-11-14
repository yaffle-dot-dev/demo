# Deliberate apply-time failure for the candidate's partial-failure acceptance case.
# The time resource ID is unknown at plan time. No cloud resources or provisioners.
resource "terraform_data" "acceptance_failure" {
  input = time_sleep.revision.id

  lifecycle {
    postcondition {
      condition     = self.output == "deliberate-acceptance-failure"
      error_message = "Intentional v6 apply failure; verify sibling progress and successor fencing."
    }
  }
}
