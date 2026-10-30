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

By 28 October the hash was `6aa44b801729` (main before it: `200eec7325e1`): Ros's research steps, the report two-step and the PDF line joined the prompt (2,766 to 4,083 characters), the `ros_read_selected` and `ros_propose_report` descriptions changed, and `ros_write_result` now answers with an `instruction` field. Tool names and arguments are still the 24 October ones, so the model reads the new wording as before; a next training round should snapshot again, because every such change moves the app further from what this round learned.

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

The model is published at [arkdong/ros-nemotron-4b-GGUF](https://huggingface.co/arkdong/ros-nemotron-4b-GGUF): the Q4_K_M GGUF, the LoRA adapter, NVIDIA's licence and its notice. Local Ros downloads it (`MODEL_REPO` in `src/server/local-ros.ts`, overridable with `ROS_LOCAL_MODEL_REPO`). Delete the VM when done.

Evaluation, from the snapshot commit, against any OpenAI-compatible server. Here that is llama-server with each model's GGUF in turn. `--max-usd` caps the total in `data/spend.jsonl`, so it is what was already spent plus the eval's budget. The only paid calls are the simulated pages and Super's own run.

```sh
llama-server -m <model>.gguf --jinja --reasoning-budget 0 -c 131072 --parallel 2 --port 4339 --alias ros-local
npx tsx training/ros-nemotron/run.ts eval --label=nano-4b-baseline --student-url=http://127.0.0.1:4339/v1 --concurrency=2 --max-usd=35
npx tsx training/ros-nemotron/run.ts eval --label=ros-nemotron --student-url=http://127.0.0.1:4339/v1 --concurrency=2 --max-usd=35
npx tsx training/ros-nemotron/run.ts eval --model=teacher --label=super --no-thinking --concurrency=4 --max-usd=35
```

## Costs (measured on 27 October)

| Part | Measured | Paid by |
|---|---|---|
| Projects and tasks | US$0.34 | Token Factory credit |
| Rollouts, two pilots and a retry of failed tasks | US$31.65 for 1,351 tasks (about US$0.02 each), 1,140 samples kept | Token Factory credit |
| H100 pilot, 40 steps | 11 min, 43 GiB peak memory | AI Cloud credit |
| H100 training, 2 epochs (134 steps) | 31.7 min, 43.2 GiB peak memory | AI Cloud credit |
| H100 VM in all: setup, pilot, waiting, a restart, merge and GGUF | about 4 hours, about US$12 at about US$3 an hour | AI Cloud credit |
| Evaluation, 28 October | US$1.08: US$0.92 for the first run and Super, US$0.16 for the rerun | Token Factory credit |

The H100 VM bills by the hour from creation, so setup, the GGUF step and idle time count too; delete it once the GGUF is copied off.

The 27 October run brought the validation loss from 0.54 (the base model) to 0.405 after epoch 1 and 0.403 after epoch 2; the training loss ended at about 0.33. The Q4_K_M GGUF is 2.84 GB: some layers stay at q5_0 or q8_0 because their 3,136 columns do not divide by 256. In llama-server its first reply was a proper `ros_read_canvas` call.

What the runs on the VM taught (already in the scripts):
- Pin torch 2.10. Its prebuilt Mamba kernels avoid a source build that fails with CUDA 13.
- LoRA cannot target the Mamba-2 out_proj or conv1d, so the targets are listed.
- Nemotron-H's remote code ignores the Trainer's num_items_in_batch, so `model_accepts_loss_kwargs` is turned off. Otherwise the loss is summed over the 16 accumulation steps.
- Evaluation runs one sample at a time and keeps only the loss. Batches of 8 with full-vocabulary logits needed 77 GiB.
- transformers 5 refuses to save the merged model as the base model ships it, so `do_sample` is set and `_tied_weights_keys` becomes a dict.
- llama.cpp's converter runs transformers 4 and cannot read a tokenizer that transformers 5 saved, so the base model's own tokenizer files go next to the merged weights.

## Evaluation (28 October)

The 95 held-out tasks, on Adam's Mac. Both small models are Q4_K_M GGUFs in llama-server, and Super ran on Token Factory.

| Model | Held-out tasks passed (of 95) | KNMI tasks (of 10) |
|---|---|---|
| Nemotron 3 Nano 4B (NVIDIA's GGUF) | 33 | 3 |
| ros-nemotron | 66 | 8 |
| Nemotron 3 Super, the teacher without its family guides | 52 | 9 |

- **Where ros-nemotron gains most:** where the base model never used the tools. Add notes went from 0 to 17 of 17, report from 0 to 5 of 6, edit existing from 1 to 5 of 6, and cannot do from 7 to 8 of 8.
- **Research:** 0 of 20 for every model, Super included. The held-out checks need saved findings and groups, and the long turns run out of room.
- **Out of room:** 14 ros-nemotron tasks still ran out of context.
- **Super:** most of its failures are answers over the word limit, because it ran without the guides it had while making the data.

The first run gave the student 32,768 tokens and scored 12 and 15. The harness injects the student like a hosted model, whose admission counts a token per byte plus 4,096 and the 8,000-token output cap, so it refused most requests over about 20 KB. The app admits Local Ros at three bytes a token up to its 64 KB request cap. The table comes from the rerun with `--student-context=65536`, which is slightly stricter than the app. `student()` now defaults to 76,096 tokens (64,000 + 4,096 + 8,000), so it admits what the app admits.

## Round 2: the structure family (30 October)

Round 2 teaches ROS the job it does on top of any agent (`src/server/ros-layer.ts`): after an agent's turn, decide **when** to give its work the map's shape, **which blocks to group** (into a group already there or a new one, with a short title) and **which to link**, in the map's six link words (supports, contradicts, answers, uses data from, builds on, part of).

How the data is made (`structure.ts`): the teacher writes well-organised maps, one per request (each with its own stage, size and style, and the titles already written in its domain, so a domain's maps differ), with groups of two to six blocks under a theme title, one to three blocks outside every group, three to ten links, and for each group the request and reply of the agent turn that added it. Each map then gives several turns, each with the map's original shape as the answer:

- **regroup:** a group's blocks came loose and the group is gone; the answer is the group again, under its own title.
- **place:** one or two blocks came out of a group that is still there; the answer puts them back.
- **mixed:** both in one turn.
- **links:** a block that fits no group came without its links; the answer is the links only.
- **leave:** a block that fits no group and has no links; the answer is to change nothing.

The teacher links more freely than it groups (in the first run about a third of its links were a stretch), so `structure-check-links` has it check each map's links once more, strictly, and the export leaves out the ones it drops (`--all-links` keeps them). The check is strict about links that are false but lenient about word and direction, so `structure-label-links` then has Super label each kept pair afresh against what each word means, saying in a few words how the blocks relate first (the right word in the right direction, or none), and the export uses those labels. Up to four of the moved blocks' links are taken away and belong to the answer; any others stay, as links the agent made itself. The landing request is built by the app's own functions (`seeTurn`, `landingAsk`) and every answer is read back by the app's own parser (`landingPlan`), so a sample is exactly what Local ROS gets and what the app keeps. Training and evaluation use round 1's domains, which never mix, and nothing comes from Claude, Codex or anyone's own projects.

Steps, from the repository root on Adam's Mac. `ROS_TRAINING_DATA` points at round 1's data folder, so the round 2 sets include round 1's turns and `--max-usd` (which caps the total in `spend.jsonl`, US$33.08 after round 1) counts everything.

```sh
export ROS_TRAINING_DATA=~/code/ros-nemotron-run/training/ros-nemotron/data
npx tsx training/ros-nemotron/run.ts structure-smoke                      # offline on a hand-written map; spends nothing
npx tsx training/ros-nemotron/run.ts structure-maps --per-domain=8 --eval-per-domain=3 --max-usd=36   # resumable; writes only what is missing
npx tsx training/ros-nemotron/run.ts structure-check-links --max-usd=37  # Super checks each map's links once more
npx tsx training/ros-nemotron/run.ts structure-label-links --max-usd=37  # Super labels each kept pair's word and direction afresh
npx tsx training/ros-nemotron/run.ts structure-export                     # structure/ and round2/train.jsonl, round2/val.jsonl, without the dropped links
npx tsx training/ros-nemotron/run.ts structure-eval --model=rules --label=rules
llama-server -m <model>.gguf --jinja --reasoning-budget 0 -c 32768 --parallel 2 --port 4339 --alias ros-local
npx tsx training/ros-nemotron/run.ts structure-eval --label=ros-nemotron --student-url=http://127.0.0.1:4339/v1
npx tsx training/ros-nemotron/run.ts structure-eval --model=teacher --label=super --max-usd=37
```

`structure-eval` prints and saves (`structure/eval/<label>.summary.json`): valid answers, group precision, recall and F1 (a block in the right group, and each pair of blocks put together in a new one), link F1 with the share of right words and directions among the right pairs, `leftAlone` (maps that needed nothing and got nothing), `missed` (maps that needed something and got nothing), title overlap and speed. Training is round 1's recipe on `round2/train.jsonl` and `round2/val.jsonl` (structure samples carry no tools); then the 95 round 1 tasks again, to check nothing dropped.

Targets for the new model: valid at least 98%, group F1 at least 0.8, left alone at least 9 times in 10, no drop on the 95 tasks, and a landing answer in 10 seconds or less (p50) on Adam's Mac. Expected cost: maps about US$1 to 3 of Token Factory credit, the H100 about 3 to 5 hours (US$9 to 15 of AI Cloud credit), Super's evaluation about US$1; about US$15 to 25 in all, capped at US$30.

## Known risks

- **Local Ros context.** Local Ros declares 32,768 tokens, and ros.ai counts each request's bytes plus 12,096 against it. The prompt and tools alone are about 19.5 KB (24 KB with Notion), so most agent turns were refused before they reached the model. Fixed in #67: loopback servers now estimate input as bytes/3.
- **Chat template.** `train_lora.py` labels each assistant turn by rendering the conversation turn by turn and stops if more than 5% of samples do not render that way. The 27 October pilot skipped none.
- **Mamba kernels.** Nemotron 3 Nano 4B is a hybrid Mamba-2 model; `mamba-ssm` and `causal-conv1d` must install on the VM. `setup-vm.sh` pins versions with prebuilt wheels and checks the import first.
- **Token Factory errors.** Now and then Token Factory answers with its own error as the reply text ("[ERROR: Agent failed ... timed out after 90 seconds]"), sometimes within a second. The adapter treats that as a failed request, `ask` tries again after 4 to 64 seconds, and a long answer (four maps at once) is split into one per request.
- **A simulated web.** Facts in search results are plausible but written by the teacher. The student learns the method (quote what a tool returned, date it, name gaps), not the facts.
