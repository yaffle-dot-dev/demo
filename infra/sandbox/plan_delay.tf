# Recovery drill only: a plan-time wait long enough for a stopped runner to be
# force-killed mid-plan. Six chained 10-second reads; changes nothing. 0 disables it.
variable "plan_delay_seconds" {
  description = "Approximate plan-time wait; any value above 0 enables six chained 10s reads"
  type        = number
  default     = 0
}

data "http" "plan_delay_1" {
  count = var.plan_delay_seconds > 0 ? 1 : 0
  url   = "https://httpbin.org/delay/10"
}

data "http" "plan_delay_2" {
  count      = var.plan_delay_seconds > 0 ? 1 : 0
  url        = "https://httpbin.org/delay/10?after=${length(data.http.plan_delay_1)}"
  depends_on = [data.http.plan_delay_1]
}

data "http" "plan_delay_3" {
  count      = var.plan_delay_seconds > 0 ? 1 : 0
  url        = "https://httpbin.org/delay/10?after=${length(data.http.plan_delay_2)}"
  depends_on = [data.http.plan_delay_2]
}

data "http" "plan_delay_4" {
  count      = var.plan_delay_seconds > 0 ? 1 : 0
  url        = "https://httpbin.org/delay/10?after=${length(data.http.plan_delay_3)}"
  depends_on = [data.http.plan_delay_3]
}

data "http" "plan_delay_5" {
  count      = var.plan_delay_seconds > 0 ? 1 : 0
  url        = "https://httpbin.org/delay/10?after=${length(data.http.plan_delay_4)}"
  depends_on = [data.http.plan_delay_4]
}

data "http" "plan_delay_6" {
  count      = var.plan_delay_seconds > 0 ? 1 : 0
  url        = "https://httpbin.org/delay/10?after=${length(data.http.plan_delay_5)}"
  depends_on = [data.http.plan_delay_5]
}
