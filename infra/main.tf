terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region

  # Sandbox account stamps Owner=vps-sandbox on everything (API rejects untagged).
  default_tags {
    tags = {
      Owner = "vps-sandbox"
    }
  }
}

# Default VPC keeps this small (hackathon infra, not a bank).
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "aws_security_group" "tor" {
  name        = "trulyopenrouter"
  description = "web + ssh in, postgres only from self"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  // Gateway for the Vercel frontend (server-to-server). Chat is key-gated,
  // admin endpoints are token-gated; keys are revocable. Testnet only.
  ingress {
    from_port   = 4121
    to_port     = 4121
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port = 5432
    to_port   = 5432
    protocol  = "tcp"
    self      = true # RDS + EC2 share this group; nothing else reaches postgres
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "tor" {
  name       = "trulyopenrouter"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_db_instance" "tor" {
  identifier             = "trulyopenrouter"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  db_name                = "tor"
  username               = "tor"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.tor.name
  vpc_security_group_ids = [aws_security_group.tor.id]
  publicly_accessible    = false
  storage_encrypted      = true
  backup_retention_period = 3
  skip_final_snapshot    = true
  apply_immediately      = true
}

resource "aws_instance" "tor" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [aws_security_group.tor.id]

  root_block_device {
    volume_size = 40
    encrypted   = true
  }
  volume_tags = { Owner = "vps-sandbox" }

  user_data = <<-EOF
    #!/bin/bash
    set -eux
    apt-get update && apt-get install -y docker.io docker-compose-plugin git
    usermod -aG docker ubuntu
    su ubuntu -c 'git clone https://github.com/Lucas749/TrulyOpenRouter /home/ubuntu/TrulyOpenRouter' || true
    cat > /home/ubuntu/NEXT-STEPS.txt <<'NEXT'
    1. scp .env.prod to this box (never commit it)
    2. docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
    3. pull the model, then add this box's origin in Privy
    Nothing here terminates TLS: the gateway is plain HTTP on :4121 and the
    public HTTPS surface is Vercel's, which reaches it over GATEWAY_URL.
    NEXT
  EOF

  tags = { Name = "trulyopenrouter" }
}
