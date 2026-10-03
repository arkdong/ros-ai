# Nebius Sandboxes REST contract — September 22, 2026

This is public-document research for ros.ai's remote execution adapter. It does not establish authenticated access, prices, a particular image's libraries, or a successful remote execution. No credentials, account records, uploads, image imports, instances, or paid calls were used. The user's beta-access confirmation and reported $35 balance are separate from these public findings.

## Endpoint and authentication

The embedded OpenAPI server is `https://api.tokenfactory.nebius.com/sandboxes/v1`. REST paths below append to that full base. Do not use the inference `/v1` API or omit the sandbox `/v1` suffix. Requests require `Authorization: Bearer <IAM token>` and `Project: <Nebius project ID>`. The CLI documents `CONTREE_TOKEN`/`NEBIUS_API_KEY` and `CONTREE_PROJECT`/`NEBIUS_AI_PROJECT` as registration inputs; that naming does not prove an arbitrary inference token has sandbox access. Keep credentials server-side. [Public OpenAPI](https://eu-north.nebius.computer/static/api.yaml), [authentication guide](https://docs.tokenfactory.nebius.com/sandboxes/cli/tutorial/installation).

The rendered REST pages sometimes omit the base URL and hide nested fields. Their `.md` variants contain the relevant OpenAPI sections and point to the same public specification. Source inspected: OpenAPI 3.0, Contree API version 1.0.0, fetched September 22. The version string does not imply the schema is immutable.

## Images and preparation

| Purpose | REST request | Result / caveat |
| --- | --- | --- |
| Discover images | `GET /images?limit=100&offset=0` | `{images:[{uuid,tag,created_at,operation_uuid}]}`; `tag` query is a prefix filter, not exact match. Maximum page limit 1000. |
| Resolve an exact tag | `GET /inspect/?tag=<URL-encoded-tag>` | `302 Location` points to an image UUID inspection endpoint. |
| Inspect exact image | `GET /inspect/{imageUUID}/` | Metadata including UUID and optional creating operation UUID. |
| Import an OCI image | `POST /images/import` JSON `{registry:{url:"docker://docker.io/<repository>@sha256:<digest>"},timeout:300}` | `201 {uuid}` plus operation `Location`; asynchronous. Omit `tag` for an image accessible privately by ID. |

[Image list](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/images/list-publicly-available-images), [tag resolution](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/inspect/find-image-by-tag), [inspection](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/inspect/inspect-an-image), [import contract](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/images/import-a-container-image-from-a-registry).

Import accepts optional registry credentials, which ros.ai should avoid for a first public-image integration. Imports flatten the image filesystem and preserve ENV, but ignore ENTRYPOINT, CMD, WORKDIR and most OCI configuration. Explicitly supply the interpreter, arguments, environment and working directory. A repeated unchanged OCI import may reuse the image UUID; this is not an execution idempotency guarantee. A supplied public tag can replace an existing tag. Resolve to a UUID before approval, and capture it as provenance. [Import behavior](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/images/import-a-container-image-from-a-registry).

No inspected source guarantees a particular preloaded pandas/NumPy/SciPy/matplotlib image. A library probe or separate trusted image preparation step is needed. Installing libraries inside a normal model-written experiment would require network access and a different permission contract; do not silently enable it.

## Inputs and execution

`POST /files` accepts **raw bytes**, `Content-Type: application/octet-stream`, and returns `201 {uuid,sha256,size}`. This is distinct from the multipart inference Files API. `GET /files/{sha256}` retrieves metadata; `HEAD` checks namespace ownership. Spawn `files` maps absolute guest paths to `{uuid,uid,gid,mode}`, where mode is an octal string such as `"0444"`. Hash-check any returned upload metadata against the exact local capture. [Upload contract](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/files/upload-a-file-to-the-server-the-body-must-be-a-file-content), [file lookup](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/files/get-file-info-by-sha256), [spawn contract](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/instances/spawn-a-new-container-instance).

Alternatively, `stdin` supports `{value,encoding:"base64",close:true}`. Its complete content is delivered to the process even when the recorded stdin event is capped. This permits a bounded captured CSV/code/parameter payload without persistent uploaded-file objects. [Running commands](https://docs.tokenfactory.nebius.com/sandboxes/cli/commands/run), [stdin schema](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/instances/spawn-a-new-container-instance).

Illustrative ros.ai request shape, with application-chosen limits and placeholders, **not a tested payload**:

```json
{
  "image": "<resolved-image-uuid>",
  "command": "/usr/local/bin/python3",
  "args": ["-I", "-c", "<trusted fixed ros.ai worker>"],
  "shell": false,
  "cwd": "/tmp/ros-ai",
  "uid": 65534,
  "gid": 65534,
  "env": {"PATH":"/usr/local/bin:/usr/bin:/bin", "MPLBACKEND":"Agg"},
  "preserve_env": false,
  "networking": {"enabled": false},
  "resources_limits": {"max_layer_bytes": 67108864},
  "timeout": 30,
  "truncate_output_at": 1048576,
  "disposable": true,
  "stdin": {"value":"<base64 captured input JSON>","encoding":"base64","close":true}
}
```

`POST /instances` returns `201` with the parsed request, generated `uuid`, and a `Location` operation URL. Persist the operation reference immediately. The image may be a UUID or `tag:<name>`; metadata resolves tags to UUIDs. `shell:false` takes arguments separately and does not inherit the image environment. Treat actual interpreter path and permissions as image-specific. [Spawn endpoint](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/instances/spawn-a-new-container-instance).

The adapter should construct later requests from its allowlisted origin and validated UUIDs. Do not blindly forward authorization to an arbitrary Location or image redirect, and preserve `/sandboxes` when a returned Location begins `/v1/...`.

## Polling, outputs and artifacts

`GET /operations/{operationId}` supports these states: `PENDING`, `ASSIGNED`, `EXECUTING`, `SUCCESS`, `FAILED`, `CANCELLED`. Respect `Retry-After` seconds. Do not request `?inflight=1` for ordinary state polling; it requests additional live log work. The result structure matters:

```text
operation.uuid / kind / status / error
operation.image_uuid                source image UUID
operation.result_image_uuid         saved result image, nullable
operation.metadata.result.state     exit_code, signal, timed_out, ...
operation.metadata.result.stdout    {value, encoding: ascii|base64, truncated}
operation.metadata.result.stderr    {value, encoding: ascii|base64, truncated}
operation.metadata.result.resources elapsed_time, user_cpu_time,
                                    system_cpu_time, max_rss, cost, ...
operation.result.image              resulting image reference, not stdout
```

Handle terminal operation status and process exit state independently: successful transport/operation completion alone is insufficient evidence that Python succeeded. Cost may be missing; preserve unknown values. [Operation schema](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operations/get-an-operation-status).

For persisted runs, `GET /inspect/{resultImageUUID}/download?path=<encoded-absolute-path>` returns a file as bytes. `GET .../list?path=...` lists a directory; `.../archive?path=...` downloads an archive. Inspecting a saved image does not spawn another execution. Download only known output paths under a bounded response size; treat all returned file names/content as untrusted. [Download API](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/inspect/download-a-file-from-image), [CLI filesystem guide](https://docs.tokenfactory.nebius.com/sandboxes/cli/tutorial/files).

For ros.ai's bounded plots, tables, metrics and CSV outputs, a disposable execution returning the existing structured result bundle through stdout can avoid a persisted result image. `disposable:true` drops filesystem state, so file-download retrieval afterward is unavailable. It does **not** document deletion of operation metadata, request data or logs. The full locally captured request and output bundle remain the reproducibility record. [Run lifecycle](https://docs.tokenfactory.nebius.com/sandboxes/cli/commands/run), [completion-event schema](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operations/stream-the-operation-event-log-via-server-sent-events).

## Controls and lifecycle limits

| Control | Documented provider behavior | ros.ai consequence |
| --- | --- | --- |
| Network | `networking.enabled:false` starts the VM without a guest network interface; default is true. | Always send false for experiments. |
| Duration | `timeout` is maximum execution seconds; REST default and service maximum are not specified. | Send a finite 30-second bound; separate queue/poll deadlines. |
| Writable storage | `resources_limits.max_layer_bytes` caps writable-layer bytes; schema default is 12 GiB. | Send an explicit smaller cap. |
| Output | `truncate_output_at` caps each stdout/stderr/stdin event-log stream; default 1 MiB, maximum 10 MiB. | Bound both provider capture and local decoding; report truncation. |
| CPU/RAM/process counts | Published request schema has no CPU, RAM or PID cap fields. | Do not claim Docker's 1 CPU/512 MiB/32 PID controls apply remotely. Worker resource limits are a separate layer. |
| Concurrency | Beta overview states 50 simultaneously running operations. | Keep ros.ai's lower admission/concurrency limit. |
| Checkpoint retention | 180 days; afterward untagged, unreferenced leaf images may be deleted. | Persist required artifacts locally, and do not promise indefinite checkpoint retention. |

[Resource/network schemas](https://eu-north.nebius.computer/static/api.yaml), [output behavior](https://docs.tokenfactory.nebius.com/sandboxes/cli/commands/run), [beta limits](https://docs.tokenfactory.nebius.com/sandboxes/overview). VM isolation is a provider-documented guarantee, not an independently established result of this research.

Cancel with `DELETE /operations/{operationId}`. `202` means accepted, not confirmed termination. Poll for a terminal status and preserve cancellation uncertainty if the server is unreachable. The published API offers removing image **tags**, not deleting an uploaded file or checkpoint itself. No deletion or retention guarantee for uploaded blobs/operation logs was found. [Cancellation](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operations/cancel-an-operation), [tag removal](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/images/remove-tags-from-an-image), [full endpoint inventory](https://eu-north.nebius.computer/static/api.yaml).

There is no published create-operation idempotency key in the inspected schema. An official SDK prerelease explicitly calls out ambiguous import/instance timeouts retrying without an idempotency key as unresolved. Therefore ros.ai should never automatically repeat a spawn after an uncertain response. Save known operation IDs durably, reconcile with GET after restart, and require explicit retry when identity cannot be recovered. `GET /operations` supports status/kind/time filters, but no client-request-key lookup is documented. [SDK release note](https://github.com/nebius/contree-sdk/releases/tag/0.4.0.dev3), [operation listing](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operations/list-operations).

## Pricing and unverified assumptions

No sandbox rate table, billing currency/credit conversion, import/storage charge, or free-beta commitment was found in the inspected official overview, API, SDK, CLI and billing pages. `resources.cost` is described only as operation cost; its units are unspecified. The SDK permits absent cost data and explicitly preserves successful execution when a cost lookup fails. Treat missing cost as unknown, not zero, and do not label that raw number USD. [Operation schema](https://docs.tokenfactory.nebius.com/api-reference/sandboxes/operations/get-an-operation-status), [SDK cost note](https://github.com/nebius/contree-sdk/releases/tag/0.4.0.dev3).

General Token Factory trial/promo credits do not establish sandbox eligibility or per-run rates. A reported $35 balance does not yield a calculable worst-case sandbox charge without those terms. The adapter can be built and tested with offline contract fixtures while exact beta pricing or a documented free allowance is resolved before cost-sensitive remote verification. [General billing](https://docs.tokenfactory.nebius.com/other-capabilities/billing-new).

Outstanding verification: account token/project access; availability and digest of a scientific Python image; native process/file permissions with nonroot execution; whether requested timeout and writable-layer limit are accepted and enforced; canceled operation termination; upload/log retention; actual cost units/rates; maximum request size; queue delay policy; remote memory/CPU envelope. No public documentation was substituted for a live integration result.
