#!/usr/bin/env bash
# Merged BF16 weights -> GGUF -> Q4_K_M, the file Local Ros downloads (it picks the q4_k_m GGUF).
# Usage: bash to_gguf.sh out/merged out/gguf
set -euo pipefail
MERGED=${1:-out/merged}; OUT=${2:-out/gguf}; mkdir -p "$OUT"
[ -d llama.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp
pip install -q -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
python llama.cpp/convert_hf_to_gguf.py "$MERGED" --outtype bf16 --outfile "$OUT/ros-nemotron-4b-BF16.gguf"
cmake -S llama.cpp -B llama.cpp/build -DGGML_CUDA=ON -DLLAMA_CURL=OFF >/dev/null && cmake --build llama.cpp/build -j --target llama-quantize llama-server >/dev/null
llama.cpp/build/bin/llama-quantize "$OUT/ros-nemotron-4b-BF16.gguf" "$OUT/ros-nemotron-4b-Q4_K_M.gguf" Q4_K_M
ls -lh "$OUT"
# Quick check that the quantised model still calls a tool through llama-server's chat template.
llama.cpp/build/bin/llama-server -m "$OUT/ros-nemotron-4b-Q4_K_M.gguf" --jinja --reasoning-budget 0 -c 32768 --port 4319 --alias ros-local >/tmp/llama.log 2>&1 &
SERVER=$!; trap 'kill $SERVER' EXIT
for _ in $(seq 60); do curl -sf localhost:4319/health >/dev/null && break; sleep 2; done
curl -s localhost:4319/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"ros-local","messages":[{"role":"user","content":"Nothing is selected. The map may still hold many blocks: call ros_read_canvas to see it before answering about it.\n\nResearcher'"'"'s message:\nWhat is on my map?"}],"tools":[{"type":"function","function":{"name":"ros_read_canvas","description":"Read the map.","parameters":{"type":"object","properties":{"nodeIds":{"type":"array","items":{"type":"string"}}}}}}]}' | python3 -c "import json,sys; m=json.load(sys.stdin)['choices'][0]['message']; print('tool call:', m.get('tool_calls'))"
