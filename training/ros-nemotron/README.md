# ros-nemotron

ros-nemotron is NVIDIA Nemotron 3 Nano 4B fine-tuned to work as Ros inside ros.ai: read the map before answering, propose canvas changes and Python through the ros.ai tools, and research with method (search in several directions, read before quoting, date sources, name disagreements and unknowns). It is the model behind **Ros on this computer** (Local Ros), for the NVIDIA x Nebius hackathon on 30 October 2026.

The teacher is Nemotron 3 Super on Nebius Token Factory (it scored 7.5/10 on the 19 October agent-loop test, against 6/10 for Nano and 0/10 for Ultra). The student learns from the teacher's best turns.

## How the data is made

Every sample is a real ros.ai agent turn. `env.ts` builds a throwaway workspace and runs the task through ros.ai's own loop (`ToolLoopAgentService`), with its real tool validation, selection scope, approvals, quote check and message clipping. Only two things are swapped in:

- **The model.** The teacher, which also reads a short per-family guide (`families.ts`). The guide is never saved in a sample, so the student learns the behaviour from the app's own system prompt and tools.
- **The web.** Tavily would cost US$0.008 a search, so `world.ts` has the teacher write search results and pages, once per query, cached on disk. Pages contain their excerpts word for word, so ros.ai's quote check still decides which findings stand. About one page in ten fails to load, as on the web.

A simulated researcher accepts the search plan (or declines it, for the `research-declined` family). Code never runs: analysis tasks stop at the approval, as they do in the app until the person approves.

`check.ts` keeps a sample only if the turn finished, its tool calls passed ros.ai's checks (a refused call the teacher then fixed is kept, but that turn is not trained on), the family's tools were used in the right order, and the answer follows the prompt: short, no headings or tables, block titles rather than IDs, and nothing pending described as done.

Families and shares: overview 7%, read and answer 13%, dataset 8%, add notes 14%, edit existing 7%, analysis 10%, research 22%, research declined 3%, report 5%, cannot do or prompt injection 11%. About 15% of turns carry the person's saved preferences, 25% have the Notion tools in the list, and about one request in ten is in Dutch.

Held out for evaluation: ten projects in domains the training data never sees, plus the ten KNMI weather tasks from the 19 October comparison, so the score compares directly with Nano's 6/10 and Super's 7.5/10.

## The frozen contract

`run.ts snapshot` saves the system prompt (`src/server/agent-prompt.ts`) and the tool schemas (`src/server/agent-tools.ts`) with their hash. Every later step refuses to run if the app's prompt or tools changed since, so all samples come from one contract. The snapshot is taken on **24 October**. After that, changes to the prompt or tools must keep the old names and arguments working, or wait for the next training round.

By 27 October three tool descriptions had changed and no arguments (hash `105560b47f79` became `1e29538128f6`). A search plan now starts without asking (#95), so a `research-declined` turn no longer happens in the app, and later changes in one turn may build on changes that still wait (#96). The model learns from the 24 October contract and should read the new wording fine. Its evaluation runs on the snapshot commit, and `smoke` runs against the app as it is now.

## Steps

From the repository root, with Node 24 and `NEBIUS_API_KEY` set (on Adam's Mac: `set -a; source ~/.config/ros.ai/keys.env; set +a`). Data goes to `training/ros-nemotron/data/` (not in git). Every paid step has a hard `--max-usd` cap kept in `data/spend.jsonl`; a request that would pass it is never sent.

```sh
npx tsx training/ros-nemotron/run.ts smoke                          # offline, spends nothing: the whole path with a scripted teacher
npx tsx training/ros-nemotron/run.ts snapshot                       # 24 Oct
npx tsx training/ros-nemotron/run.ts projects --per-domain=4 --max-usd=2
npx tsx training/ros-nemotron/run.ts tasks --max-usd=2
npx tsx training/ros-nemotron/run.ts rollout --limit=40 --max-usd=3  # pilot: cost per task and pass rate per family
npx tsx training/ros-nemotron/run.ts report
npx tsx training/ros-nemotron/run.ts rollout --limit=2400 --concurrency=4 --max-usd=22
npx tsx training/ros-nemotron/run.ts export                         # data/train.jsonl, data/val.jsonl
```

Rollouts resume where they stopped, so a closed laptop or a cap only pauses them.

Training, on one Nebius AI Cloud H100 (copy `train/` and the two jsonl files to the VM):

```sh
bash setup-vm.sh
python train_lora.py --train train.jsonl --val val.jsonl --pilot     # 40 steps: speed, memory, and the full run's cost
python train_lora.py --train train.jsonl --val val.jsonl --out out   # LoRA r=32 on attention, MLP and Mamba in_proj, 2 epochs
bash to_gguf.sh out/merged out/gguf                                  # BF16 GGUF, Q4_K_M, and a tool-call check in llama-server
```

Then publish `ros-nemotron-4b-Q4_K_M.gguf` with NVIDIA's Open Model License text to a Hugging Face model repo, and point Local Ros at it (`MODEL_REPO` in `src/server/local-ros.ts`, overridable today with `ROS_LOCAL_MODEL_REPO`). Delete the VM when done.

Evaluation, against any OpenAI-compatible server (Local Ros listens on 127.0.0.1:4319 with its own key):

```sh
ROS_STUDENT_KEY=<local key> npx tsx training/ros-nemotron/run.ts eval --label=nano-4b-baseline
ROS_STUDENT_KEY=<local key> npx tsx training/ros-nemotron/run.ts eval --label=ros-nemotron
npx tsx training/ros-nemotron/run.ts eval --model=teacher --label=super --max-usd=3
```

## Costs (measured on 27 October)

| Part | Measured | Paid by |
|---|---|---|
| Projects and tasks | US$0.34 | Token Factory credit |
| Rollouts, two pilots and a retry of failed tasks | US$31.65 for 1,351 tasks (about US$0.02 each), 1,140 samples kept | Token Factory credit |
| H100 pilot, 40 steps | 11 min, 43 GiB peak memory | AI Cloud credit |
| H100 training, 2 epochs (134 steps) | 31.7 min, 43.2 GiB peak memory | AI Cloud credit |
| H100 VM in all: setup, pilot, waiting, a restart, merge and GGUF | about 4 hours, about US$12 at about US$3 an hour | AI Cloud credit |
| Evaluation | under US$3 (estimate) | Token Factory credit |

The H100 VM bills by the hour from creation, so setup, the GGUF step and idle time count too; delete it once the GGUF is copied off.

The 27 October run brought the validation loss from 0.54 (the base model) to 0.405 after epoch 1 and 0.403 after epoch 2; the training loss ended at about 0.33. The Q4_K_M GGUF is 2.84 GB: some layers stay at q5_0 or q8_0 because their 3,136 columns do not divide by 256. In llama-server its first reply was a proper `ros_read_canvas` call.

What the runs on the VM taught (already in the scripts):
- Pin torch 2.10. Its prebuilt Mamba kernels avoid a source build that fails with CUDA 13.
- LoRA cannot target the Mamba-2 out_proj or conv1d, so the targets are listed.
- Nemotron-H's remote code ignores the Trainer's num_items_in_batch, so `model_accepts_loss_kwargs` is turned off. Otherwise the loss is summed over the 16 accumulation steps.
- Evaluation runs one sample at a time and keeps only the loss. Batches of 8 with full-vocabulary logits needed 77 GiB.
- transformers 5 refuses to save the merged model as the base model ships it, so `do_sample` is set and `_tied_weights_keys` becomes a dict.
- llama.cpp's converter runs transformers 4 and cannot read a tokenizer that transformers 5 saved, so the base model's own tokenizer files go next to the merged weights.

## Known risks

- **Local Ros context.** Local Ros declares 32,768 tokens, and ros.ai counts each request's bytes plus 12,096 against it. The prompt and tools alone are about 19.5 KB (24 KB with Notion), so most agent turns were refused before they reached the model. Fixed in #67: loopback servers now estimate input as bytes/3.
- **Chat template.** `train_lora.py` labels each assistant turn by rendering the conversation turn by turn and stops if more than 5% of samples do not render that way. The 27 October pilot skipped none.
- **Mamba kernels.** Nemotron 3 Nano 4B is a hybrid Mamba-2 model; `mamba-ssm` and `causal-conv1d` must install on the VM. `setup-vm.sh` pins versions with prebuilt wheels and checks the import first.
- **A simulated web.** Facts in search results are plausible but written by the teacher. The student learns the method (quote what a tool returned, date it, name gaps), not the facts.
