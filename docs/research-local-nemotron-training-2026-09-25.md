# Local Nemotron customization for ros.ai

Research date: 2026-09-25. Status: feasibility research and proposed development path, not an implemented or benchmarked model. No training, model downloads, installations, paid calls, or publication were performed for this research.

## Recommendation

Build a small local research-structure assistant by fine-tuning an existing Nemotron model on examples of ros.ai behavior. Use Nebius GPU infrastructure and NVIDIA training tooling during development, then distribute an inference artifact that runs locally. Training from scratch is unnecessary. Local inference does not itself require fine-tuning; benchmark the original model first so customization has a measurable purpose.

The first candidate is **NVIDIA-Nemotron-3-Nano-4B-BF16**, with the vendor's Q4_K_M GGUF as the initial local baseline. Evaluate a narrow assistant that proposes research questions, organizes selected notes, identifies unsupported claims, and produces valid proposed canvas changes. Keep factual project evidence in local retrieval/context rather than trying to memorize it into weights.

## Candidate models and evidence

| Candidate | Verified facts | Decision |
| --- | --- | --- |
| Nemotron 3 Nano 4B | 3.97B parameters; hybrid Mamba-2/Transformer; English; BF16 training weights; commercial use under NVIDIA Nemotron Open Model License. | Preferred first candidate. |
| Nemotron Nano 9B v2 | NeMo AutoModel publishes explicit SFT and LoRA recipes. | A larger fallback if the 4B export/training route blocks or quality is inadequate. |
| Nemotron 3 Nano 30B-A3B | AutoModel lists SFT and LoRA recipes. The active parameter count does not mean a 3B-sized download or memory footprint. | Not the first laptop target. |
| Nemotron Flash 1B | Vendor model card is CC-BY-NC-4.0. | Do not choose merely for its size; noncommercial terms are a poor default for ros.ai distribution. |

Sources: [4B model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16), [AutoModel Nemotron recipes](https://docs.nvidia.com/nemo/automodel/latest/model-coverage/large-language-models/nemotron-h), [Flash 1B model card](https://huggingface.co/nvidia/Nemotron-Flash-1B).

NVIDIA describes Nano 4B as an on-device model and reports RTX 4070 evaluation with llama.cpp Q4_K_M. Its release article explains pruning and distillation from Nano 9B v2, then task-focused post-training. These are evidence that the model is designed for this class of deployment, not proof of ros.ai quality or Mac performance. [NVIDIA release article](https://huggingface.co/blog/nvidia/nemotron-3-nano-4b)

## The current Mac is a plausible inference target

The coordinating agent's read-only hardware inspection found Apple M5, model Mac17,2, and 34,359,738,368 bytes of memory (32 GiB). NVIDIA's official Q4_K_M GGUF file is approximately **2.84 GB**. That makes this a reasonable candidate for the observed machine, but file size is not peak runtime memory. Context state, buffers, the OS, browser, and ros.ai consume additional memory. Start with bounded context rather than the model's advertised maximum. [Official GGUF files](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF/tree/main)

NVIDIA publishes a llama.cpp server example for this GGUF. llama.cpp supports Apple Silicon via Metal and offers an OpenAI-compatible local API. This supports a credible Mac implementation path without requiring an NVIDIA GPU on the user's machine. Actual loading, prompt processing, output speed, memory, structured responses, and sustained interaction still need measurement on this Mac. [NVIDIA GGUF model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF), [llama.cpp](https://github.com/ggml-org/llama.cpp)

Proposed deployment: a pinned native llama.cpp process bound to loopback, managed by ros.ai, loading a verified local model file. Treat the engine/model as versioned app resources. Test network-disabled operation after installation. Downloading weights once and running offline afterward is different from a completely offline installer; offer the latter separately if needed.

## Where Nebius and NVIDIA enter the build

There are two different Nebius routes:

1. **Nebius GPU VM + NVIDIA training stack:** control the model, recipe, checkpoint files, and export. Nebius documents single-GPU H100 (80 GB), H200 (141 GB), and L40S (48 GB) options, among others. Availability is region/quota dependent. This is the proposed route for the exact Nemotron 4B model. [Nebius GPU VM types](https://docs.nebius.com/compute/virtual-machines/types)
2. **Token Factory managed fine-tuning:** convenient job APIs and downloadable checkpoint files, but its current published training catalog does **not** list Nemotron/NVIDIA. It lists other model families including Qwen, Llama, Gemma, GPT-OSS and DeepSeek. Inference availability must not be mistaken for fine-tuning support. Confirm any unlisted Nemotron offering with Nebius before relying on it. [Supported training models](https://docs.tokenfactory.nebius.com/post-training/models), [Managed SFT and checkpoint download](https://docs.tokenfactory.nebius.com/post-training/how-to-fine-tune)

No existing Token Factory inference allowance should be assumed to pay for GPU VMs or training. Before any live run, obtain a concrete quote/credit scope and explicit budget authorization covering compute, storage, transfer, and retries. An experiment must have a conservatively enforceable cost ceiling and a cleanup plan.

## Exact NVIDIA training support and its limits

The NVIDIA Megatron Bridge nightly page contains recorded **4B-specific** BF16 import/export, SFT, and LoRA configurations, last verified July 20, 2026. Its LoRA card uses eight H100 GPUs, TP1/DP8, rank 8, alpha 16, and attention projection targets. The recorded base revision is `dfaf35de3e30f1867dd8dbc38a7fc9fb52d3914f`. It reports a reloadable adapter checkpoint. [Exact 4B verification cards](https://docs.nvidia.com/nemo/megatron-bridge/nightly/models/nemotron/nemotron3-nano-4b.html)

**Documentation caveat:** that page's introductory description and example environment variables incorrectly describe the 30B model; the verification cards explicitly identify the 4B model and 3,973,556,832 parameters. Pin and inspect the corresponding source recipe before running it; do not copy the introductory setup blindly.

**Single-GPU LoRA is a proposed adaptation, not verified here.** TP1/DP8 suggests the recorded run uses data-parallel replicas, making one-device exploration plausible, but batch size, runtime kernels, memory and throughput still require a bounded pilot. Eight GPUs in the reference are not proof eight GPUs are necessary. Equally, this research does not prove one H100/L40S is sufficient for the selected configuration. Exact 4B QLoRA support was not established; do not promise it from generic framework capabilities.

NeMo AutoModel documents supervised fine-tuning and parameter-efficient fine-tuning with custom examples. It is another NVIDIA route to investigate, but an explicit AutoModel recipe for this exact Nano 4B release was not found during this review. [AutoModel fine-tuning guide](https://docs.nvidia.com/nemo/automodel/latest/recipes-e2e-examples/sft-peft)

## What gets saved and shipped

These are different artifacts:

| Artifact | Purpose | Distribution implication |
| --- | --- | --- |
| Training checkpoint | Resume training; may include distributed shards, optimizer, RNG and training configuration. | Archive for reproducibility; do not make users install the whole training state. |
| LoRA adapter | The learned changes over an exact base model. | Small, but cannot perform inference alone; base weights and compatible runtime are still required. |
| Merged model | Base weights with trained adapter incorporated. | Easier deployment candidate; preserve base revision and adapter provenance. |
| Quantized GGUF | Smaller runtime representation for llama.cpp. | Proposed local release artifact; evaluate after conversion because quantization can alter behavior. |

The proposed release pipeline is BF16 base → LoRA training → merge/export → GGUF conversion/quantization → local evaluation → packaged model. Each arrow is an integration check. Existing vendor GGUF support proves the architecture can be served this way; it does not prove our trained adapter has already merged/exported correctly. Preserve the unfused adapter and canonical higher-precision weights alongside the final inference artifact.

Recommended model manifest: base repository and immutable revision, tokenizer/chat-template versions, training code/container digest, dataset version and split hashes, adapter hash, merge/export commands, quantization settings, final file hash, evaluation results, license/notice files, and supported runtime version. A model checkpoint does not contain a user's research database or its current evidence.

## Redistribution and open source

The governing NVIDIA Nemotron Open Model License permits commercial use and derivative distribution subject to its conditions. Redistributors must provide the license, retain applicable notices, and handle any required NOTICE attribution. It does not grant general trademark rights. Keep ros.ai's application license separate from the model's terms. [Governing NVIDIA license](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/)

The official GGUF repository currently displays a zero-byte LICENSE file, so simply copying that file would not supply the governing text. Package the actual license and applicable notices explicitly. Verify the exact pinned model's files and terms before release. This is a packaging requirement identified from the source, not authorization to publish.

Open contributions should include the task definition, redistributable training examples, held-out evaluation method, training recipe and environment, adapter, model provenance, and optionally the merged quantized model. Keep private research, secrets, and active grants out of training and distribution. Training creates durable learned artifacts, so later deleting a project is not equivalent to removing its influence from a trained model.

## Validation gates before committing to training

1. Establish a local untuned 4B baseline on the M5; verify the full required interaction and JSON/proposal behavior, not a single chat response.
2. Prepare representative reviewed examples and held-out project-level evaluation cases; compare prompting/retrieval against the proposed fine-tune.
3. Pin NVIDIA training/export tooling and test compatibility; settle the single-GPU feasibility and budget with a bounded pilot after authorization.
4. Compare untuned, trained higher-precision, and trained quantized outputs using the same held-out tasks.
5. Demonstrate offline operation, provenance, undo, and permission enforcement with the final app resource.

Training is justified if it improves research-structure behavior beyond the prompted baseline without weakening evidence grounding or user control. Building with Nebius and NVIDIA can produce an inspectable technical contribution even though end-user inference runs on Apple Silicon.

## Concrete ros.ai specialization

Source inspection on September 25 found a useful existing contract in `src/server/assistant.ts`: reply, clarified question, source references, proposed memory entries, and bounded tools. The current assistant can propose notes, search, experiments and explicit result reuse. The first local specialization should cover conversation, clarification, note proposals and evidence-grounded memory only. Local inference should not automatically gain external search or code execution authority.

Proposed task examples:

- A vague research question: ask one useful clarification instead of generating a generic multi-stage plan.
- An adequately specified question: propose three to five independent Knowledge/Action notes with reasons and optional relationships.
- Existing user structure: suggest a minimal addition/update without replacing the user's organization.
- A source excerpt or actual calculation: distinguish a supported finding from a hypothesis, uncertainty or gap; cite only supplied IDs.
- A follow-up correction: revise a proposed interpretation while preserving the original question and saved evidence.
- Missing or contradictory evidence: explain what is missing instead of inventing an experiment outcome.

Keep project memory, documents, datasets and current facts in local storage and selected model context. Fine-tuning teaches reusable behavior; it is not the project's memory mechanism. A smaller model's factual verdict is not proof of scientific validity.

## Dataset and evaluation proposal

These are initial experiment sizes, not proven requirements: author 50–100 high-quality seed interactions, grow toward 500–2,000 reviewed training examples if the baseline reveals a learnable gap, and reserve a separate 100–200-case evaluation set. Start with smaller pilots before scaling. Use public/synthetic research scenarios and explicitly consented examples; do not automatically upload or train on existing private project histories.

Each example should contain the exact compact workspace snapshot available at inference, user request, valid proposed JSON response, and explicit reference/behavior expectations. Include empty projects, existing structures, follow-ups, ambiguous requests, unsupported claims, malicious instructions inside source text, and requests requiring unavailable tools. Randomize identifiers. Split by whole project/scenario family before generating paraphrases to prevent leakage. Do not train hidden reasoning traces as project evidence.

NVIDIA NeMo Data Designer is a candidate for producing structured synthetic variants; it supports configurable OpenAI-compatible model providers. A proposed integration would use Nemotron through Nebius Token Factory to draft examples, followed by schema/reference checks and human review. Compatibility with the selected endpoint must still be verified. Generated examples are drafts, not ground truth. [Data Designer](https://github.com/NVIDIA-NeMo/DataDesigner), [maintainer explanation of custom providers](https://github.com/NVIDIA-NeMo/DataDesigner/discussions/113).

Evaluate the untuned baseline with a strong prompt and the same selected context as the adapted model. Hold prompt, schema constraints, decoding budget and task inputs fixed for the primary comparison; measure prompt compression separately. Evaluate the trained higher-precision export and final quantized Mac artifact to distinguish training gains from quantization effects. Keep test cases untouched by training and checkpoint selection.

Measure:

- Valid response and tool schema, valid existing references, and valid proposed graph structure.
- Human-rated usefulness of questions and proposed notes, with blind paired comparisons and reported sample counts.
- Unsupported findings, invented source IDs, unnecessary edits and failure to acknowledge missing evidence.
- Successful completion over multiple turns, including corrections and focused context changes.
- Time to a complete valid proposal, peak memory and failure rates on the actual Mac; include cold-start cost separately.
- Offline operation with network unavailable after installation, and preservation of approval/undo semantics.

Model evaluation is a focused research experiment, not a request to add or run broad application unit suites. Preserve the repository's compact build/type/browser verification preference for any later implementation.

## Implementation seams and packaging

`src/server/providers.ts` already defines `ModelAdapter`; add a local implementation without importing cloud authorization requirements into local inference. `src/shared/model-settings.ts` and `src/server/model-settings.ts` currently enumerate only Nebius/OpenAI and need an explicit local option. `src/server/execution.ts` contains provider-specific admission/accounting and must distinguish local resource limits from paid budgets. Record actual model hashes and runtime settings in saved attempts.

The current project assistant allocates up to 60,000 bytes for its model context and requests up to 6,000 output tokens. Bytes are not tokens, and that envelope is not a demonstrated small-model latency target. Select relevant local context and simplify the first task contract; measure usefulness before increasing context. Schema-constrained output can help syntax, but existing application validators and authority must remain the enforcement boundary.

Offer a small app with an optional versioned model download, plus an offline bundle if desired. Store inference weights, tokenizer/template, manifest and license locally. Keep training checkpoints outside the normal installer. Verify hashes and allow reverting model versions; do not silently fetch a new model or switch to cloud inference when local execution fails.

## Hackathon interpretation

The user's September 25 report of a Nebius judge encouraging training is useful qualitative feedback. The published judging criteria emphasize technological implementation, coherent design, impact and quality of the idea; training itself is not listed as mandatory or a guaranteed score boost. The official rules define running on Nebius as runtime Token Factory calls or deployment/run using AI Cloud compute. Do not assume training-only use followed by entirely local runtime satisfies that requirement; retain the existing optional runtime Token Factory path and document the demonstrated submission configuration, or obtain organizer clarification. [Hackathon overview and criteria](https://nebiusglobalaihackathon.devpost.com/), [official rules](https://nebiusglobalaihackathon.devpost.com/rules).

The proposed contribution is: specialize a NVIDIA model on Nebius infrastructure, publish the permitted recipe/data/adapter/evaluation, and demonstrate useful private research assistance on a Mac. The main evidence should be a measured improvement over the same base model, not just a training log or reduced training loss. This research note does not activate a goal, authorize cloud spending or adopt the proposal as completed implementation.
