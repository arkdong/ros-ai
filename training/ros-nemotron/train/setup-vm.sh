#!/usr/bin/env bash
# One Nebius AI Cloud VM with one H100 (80 GB), Ubuntu 22.04 or 24.04 "for NVIDIA GPUs" (CUDA 12 or 13 drivers;
# the cu126 PyTorch wheels run on both).
# Copy this folder and data/train.jsonl, data/val.jsonl to the VM, then run: bash setup-vm.sh
set -euo pipefail
sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv python3-dev git cmake build-essential
# The image's own Python (3.10 on 22.04, 3.12 on 24.04); both work.
python3 -m venv ~/venv && source ~/venv/bin/activate
pip install -q --upgrade pip wheel
# torch 2.10: mamba-ssm and causal-conv1d have prebuilt wheels for torch 2.6-2.10 only. A newer torch makes pip build them from
# source, which fails with the CUDA 13 compiler on Nebius's Ubuntu 24.04 image.
pip install -q "torch==2.10.*" numpy --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple
pip install -q -r requirements.txt --no-build-isolation
mkdir -p out && pip freeze > out/pip-freeze.txt
nvidia-smi --query-gpu=name,memory.total --format=csv
python -c "import torch, mamba_ssm; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'mamba_ssm ok')"
