"""LoRA fine-tune of Nemotron 3 Nano 4B on the exported ros.ai samples, on one H100.

Usage (on the VM, after setup-vm.sh):
    python train_lora.py --train ../data/train.jsonl --val ../data/val.jsonl --out out
    python train_lora.py --pilot ...   # 40 steps, to measure speed and memory before the full run

Each sample is rendered with the model's own chat template (tools included, thinking off, as Local
Ros runs it with --reasoning-budget 0). Loss falls only on assistant turns marked train: true, so the
model learns its tool calls and answers, never the tool results, and never a call ros.ai refused.
"""
import argparse, json, math, os, time

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainerCallback, TrainingArguments

BASE = "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16"

parser = argparse.ArgumentParser()
parser.add_argument("--train", required=True)
parser.add_argument("--val")
parser.add_argument("--out", default="out")
parser.add_argument("--base", default=BASE)
parser.add_argument("--max-tokens", type=int, default=24576)
parser.add_argument("--epochs", type=float, default=2)
parser.add_argument("--lr", type=float, default=1e-4)
parser.add_argument("--rank", type=int, default=32)
parser.add_argument("--pilot", action="store_true")
parser.add_argument("--usd-per-hour", type=float, default=3.0, help="the VM's price, so ros.ai's Training block can show the GPU spend")
args = parser.parse_args()

tokenizer = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token


def render(messages, tools, generation=False):
    return tokenizer.apply_chat_template(messages, tools=tools, tokenize=False, add_generation_prompt=generation, enable_thinking=False)


skipped = {"template": 0, "long": 0}


def encode(sample):
    """Token ids and labels; None when the template does not render turn by turn or the sample is too long."""
    messages = [{key: value for key, value in message.items() if key != "train"} for message in sample["messages"]]
    tools = sample["tools"]
    full = render(messages, tools)
    spans = []
    for index, message in enumerate(sample["messages"]):
        if message["role"] != "assistant" or not message.get("train", True):
            continue
        before, upto = render(messages[:index], tools, True), render(messages[: index + 1], tools)
        # A template that rewrites earlier turns would put the labels in the wrong place; skip such samples.
        if not upto.startswith(before) or not full.startswith(upto):
            skipped["template"] += 1
            return None
        spans.append((len(before), len(upto)))
    encoded = tokenizer(full, add_special_tokens=False, return_offsets_mapping=True)
    ids = encoded["input_ids"]
    if len(ids) > args.max_tokens:
        skipped["long"] += 1
        return None
    labels = [token if any(start <= begin < end for start, end in spans) else -100 for token, (begin, _) in zip(ids, encoded["offset_mapping"])]
    return {"input_ids": ids, "labels": labels}


def load(file):
    rows = [encode(json.loads(line)) for line in open(file) if line.strip()]
    return [row for row in rows if row]


train = load(args.train)
val = load(args.val) if args.val else None
tokens = sum(len(row["input_ids"]) for row in train)
trained = sum(sum(label != -100 for label in row["labels"]) for row in train)
print(f"{len(train)} training samples, {tokens:,} tokens ({trained:,} trained); skipped {skipped}")
if skipped["template"] > len(train) * 0.05:
    raise SystemExit("More than 5% of samples do not render turn by turn with this chat template. Inspect one before training.")


def collate(batch):
    width = max(len(row["input_ids"]) for row in batch)
    pad = lambda values, fill: values + [fill] * (width - len(values))
    return {
        "input_ids": torch.tensor([pad(row["input_ids"], tokenizer.pad_token_id) for row in batch]),
        "labels": torch.tensor([pad(row["labels"], -100) for row in batch]),
        "attention_mask": torch.tensor([pad([1] * len(row["input_ids"]), 0) for row in batch]),
    }


model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.bfloat16, trust_remote_code=True, device_map={"": 0})
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
model.enable_input_require_grads()
# All linear layers: attention, MLP and the Mamba-2 in/out projections.
model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=2 * args.rank, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM"))
model.print_trainable_parameters()

steps_per_epoch = math.ceil(len(train) / 16)
training = TrainingArguments(
    output_dir=args.out, per_device_train_batch_size=1, gradient_accumulation_steps=16, learning_rate=args.lr,
    num_train_epochs=args.epochs, max_steps=40 if args.pilot else -1, lr_scheduler_type="cosine", warmup_ratio=0.03,
    bf16=True, logging_steps=5, save_strategy="no" if args.pilot else "epoch", eval_strategy="epoch" if val and not args.pilot else "no",
    report_to=[], remove_unused_columns=False, group_by_length=True, dataloader_num_workers=2,
)


class Metrics(TrainerCallback):
    """One JSON line per log in out/metrics.jsonl, which ros.ai's Training block reads to draw the loss curve."""

    def __init__(self):
        os.makedirs(args.out, exist_ok=True)
        self.file = open(f"{args.out}/metrics.jsonl", "w", buffering=1)

    def write(self, **row):
        self.file.write(json.dumps({"seconds": round(time.time() - started, 1), **row}) + "\n")

    def on_train_begin(self, _args, state, _control, **_):
        self.write(event="begin", pilot=args.pilot, max_steps=state.max_steps, epochs=args.epochs, usd_per_hour=args.usd_per_hour,
                   base=args.base, rank=args.rank, lr=args.lr, samples=len(train))

    def on_log(self, _args, state, _control, logs=None, **_):
        row = {key: logs[key] for key in ("loss", "eval_loss") if logs and key in logs}
        if row:
            self.write(step=state.global_step, epoch=round(state.epoch or 0, 3), **row)

    def on_train_end(self, _args, state, _control, **_):
        self.write(event="end", step=state.global_step)


started = time.time()
Trainer(model=model, args=training, train_dataset=train, eval_dataset=val, data_collator=collate, callbacks=[Metrics()]).train()
seconds = time.time() - started
print(f"Trained in {seconds / 60:.1f} min; peak GPU memory {torch.cuda.max_memory_allocated() / 2**30:.1f} GiB.")
if args.pilot:
    full_minutes = seconds / 40 * steps_per_epoch * args.epochs / 60
    print(f"Pilot: the full run of {args.epochs} epochs would take about {full_minutes:.0f} min ({full_minutes / 60 * 3:.0f} US$ at about US$3 an H100 hour).")
    raise SystemExit

model.save_pretrained(f"{args.out}/adapter")
merged = model.merge_and_unload()
merged.save_pretrained(f"{args.out}/merged", safe_serialization=True)
tokenizer.save_pretrained(f"{args.out}/merged")
json.dump({"base": args.base, "samples": len(train), "tokens": tokens, "epochs": args.epochs, "lr": args.lr, "rank": args.rank, "minutes": seconds / 60}, open(f"{args.out}/training.json", "w"), indent=2)
print(f"Adapter in {args.out}/adapter, merged weights in {args.out}/merged. Next: bash to_gguf.sh {args.out}/merged {args.out}/gguf")
