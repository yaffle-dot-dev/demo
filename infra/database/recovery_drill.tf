# Recovery drill: a state-only resource whose destroy waits, so an apply can be
# interrupted mid-delete. Set drill_slow_delete_count to 1 to create it, then 0.
variable "drill_slow_delete_count" {
  type    = number
  default = 0
}

resource "time_sleep" "slow_delete" {
  count            = var.drill_slow_delete_count
  destroy_duration = "120s"
}
