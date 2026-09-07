variable "region" {
  description = "AWS region (sandbox: us-west-2 only)"
  type        = string
  default     = "us-west-2"
}

variable "instance_type" {
  description = "EC2 size (2 vCPU / 4 GB minimum for CPU inference)"
  type        = string
  default     = "t3.medium"
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH"
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "Your IP for SSH (e.g. 1.2.3.4/32) — NOT 0.0.0.0/0"
  type        = string
}

variable "db_password" {
  description = "RDS master password (openssl rand -hex 24)"
  type        = string
  sensitive   = true
}

output "ec2_public_ip" {
  value = aws_instance.tor.public_ip
}

output "rds_endpoint" {
  value = aws_db_instance.tor.endpoint
}

output "next_env" {
  description = "Paste into .env.prod"
  value       = "POSTGRES_HOST=${aws_db_instance.tor.address}\nPOSTGRES_USER=tor\nPOSTGRES_PASSWORD=<the db_password you set>"
}
