#!/usr/bin/env bash
# One Nebius AI Cloud VM with one H100 (80 GB), Ubuntu 22.04 with CUDA 12 drivers.
# Copy this folder and data/train.jsonl, data/val.jsonl to the VM, then run: bash setup-vm.sh
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq python3.11-venv git cmake build-essential
python3.11 -m venv ~/venv && source ~/venv/bin/activate
pip install -q --upgrade pip wheel
pip install -q torch --index-url https://download.pytorch.org/whl/cu126
pip install -q -r requirements.txt --no-build-isolation
mkdir -p out && pip freeze > out/pip-freeze.txt
nvidia-smi --query-gpu=name,memory.total --format=csv
python -c "import torch, mamba_ssm; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'mamba_ssm ok')"
