# Recovery drill only: a plan-time wait long enough for a stopped runner to be
# force-killed mid-plan. Reads nothing and changes nothing; 0 disables it.
variable "plan_delay_seconds" {
  description = "Plan-time wait (0-120 whole seconds)"
  type        = number
  default     = 0

  validation {
    condition     = var.plan_delay_seconds >= 0 && var.plan_delay_seconds <= 120 && floor(var.plan_delay_seconds) == var.plan_delay_seconds
    error_message = "plan_delay_seconds must be a whole number between 0 and 120."
  }
}

data "external" "plan_delay" {
  count   = var.plan_delay_seconds > 0 ? 1 : 0
  program = ["/bin/sh", "-c", "/bin/sleep ${var.plan_delay_seconds}; echo '{}'"]
}
