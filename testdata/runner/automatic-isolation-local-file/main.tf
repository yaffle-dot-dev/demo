terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.3"
    }
  }
}

variable "filename" {
  type    = string
  default = "preview-file"
}

resource "local_file" "preview" {
  filename = var.filename
  content  = "automatic preview isolation"
}

output "filename" {
  value = local_file.preview.filename
}
