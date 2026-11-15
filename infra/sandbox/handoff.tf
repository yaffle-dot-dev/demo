# A revision change replaces this state-only resource and repeats the bounded wait.
# No provisioners, remote services, callbacks, or destroy-time delays are involved.
variable "test_revision" {
  description = "Acceptance push marker; change all six yaffle.toml values together"
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,32}$", var.test_revision))
    error_message = "Use a short revision marker such as A, B, or C."
  }
}

variable "delay_seconds" {
  description = "Local create-time wait on each new revision (0-120 whole seconds)"
  type        = number
  nullable    = false

  validation {
    condition     = var.delay_seconds >= 0 && var.delay_seconds <= 120 && floor(var.delay_seconds) == var.delay_seconds
    error_message = "delay_seconds must be a whole number between 0 and 120."
  }
}

resource "time_sleep" "revision" {
  create_duration = "${var.delay_seconds}s"
  triggers = {
    revision = var.test_revision
  }
}

output "test_revision" {
  description = "Applied revision marker, read from the actual waited resource"
  value       = time_sleep.revision.triggers.revision
}
