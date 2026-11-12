#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu VM for ros.ai. Run as the VM's admin user: bash bootstrap.sh
set -euo pipefail

# Docker Engine and the compose plugin, from Docker's own repository.
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

# Where the deploy workflow copies the app (/opt/ros-ai) and the gateway (/opt/ros-ai-cloud),
# and where settings live (outside both copies, so a deploy never touches them).
sudo mkdir -p /opt/ros-ai /opt/ros-ai-cloud /etc/ros-ai
sudo chown "$USER" /opt/ros-ai /opt/ros-ai-cloud
sudo chmod 700 /etc/ros-ai

# Only SSH and the web ports are open.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "Done. Log out and back in once, then put cloud.env and postgres-ca.pem in /etc/ros-ai (see docs/nebius-deployment.md)."
