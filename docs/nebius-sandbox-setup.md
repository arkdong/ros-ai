# Nebius Sandboxes setup

Nebius Sandboxes is a separate, explicitly selected remote execution backend. Local Docker research and the bounded numerical interpreter remain available. The continuous project assistant can propose exact code for either runtime, while the earlier dataset-specific Action research loop continues to use Docker. A remote proposal is a local preview, not an executed sandbox or a move of the local service to the cloud.

**Normal product admission remains blocked while sandbox pricing, billing units and applicable free terms are unverified.** A separate September 23 one-session beta smoke was explicitly authorized despite that uncertainty, executed remotely, and consumed its one-use scope. See [the actual receipt and boundary](provider-account-usage.md#narrow-sandbox-smoke-exception). Do not rerun its script or infer ongoing authorization. The September 22 build authorization allows up to US$10 of combined new Nebius inference and sandbox spending; it does not supply the missing sandbox price.

## Credentials and image

Keep the existing ignored `.env.local` file and add only missing settings. Do not overwrite it with `.env.example`, expose credentials through `VITE_` variables, or put account identifiers in committed files.

```dotenv
NEBIUS_API_KEY=<existing server-side credential>
NEBIUS_PROJECT_ID=<existing project ID from the Nebius console>
```

The default remote image is the publicly available Python 3.12-slim image pinned to UUID `4fa16c8f-62a9-35a4-a4ea-07b7e8cd44ae`. `ROS_NEBIUS_SANDBOX_IMAGE_ID` can select another verified compatible image UUID; ros.ai does not import or prepare an image automatically. An image name, available credential or successful metadata lookup does not prove a remote experiment has run successfully.

This runtime provides Python's standard library. It does not provide pandas, NumPy, SciPy or Matplotlib. Select the existing local Docker runtime when an analysis needs those libraries. No fallback silently changes an experiment's selected runtime.

## Combined Nebius build allowance

The September 22 continuous-assistant build has **one additional US$10 maximum shared by new Nebius inference and sandbox attempts**. It is not US$10 for each service, per project, per retry or per restart. An account balance is neither an authorization amount nor a per-run sandbox price.

| Server setting | Meaning |
| --- | --- |
| `ROS_NEBIUS_COMBINED_AUTHORIZATION_ID` | Stable identifier for this build’s explicit combined authorization. |
| `ROS_NEBIUS_COMBINED_AUTHORIZED_USD` | Authorized total, greater than zero and no more than 10; blank or zero disables new Nebius work. |

These defaults are deliberately disabled in `.env.example`:

```dotenv
# Disabled reference values; preserve any existing authorized .env.local settings.
ROS_NEBIUS_COMBINED_AUTHORIZATION_ID=
ROS_NEBIUS_COMBINED_AUTHORIZED_USD=0
```

Configure an authorized amount only in the ignored server-side file. New inference also needs the existing `ROS_PAID_AUTHORIZATION_ID`, `ROS_NEBIUS_AUTHORIZED_USD` and `ROS_PAID_MAX_REQUESTS` settings. Project permissions and resource limits apply independently. These overlapping limits constrain the same work; they do not add separate spending allowances together.

The combined grant is saved once for this build and retains conservative reservations across projects, outcomes and restarts. An admitted inference call or remote attempt reduces the same remaining ceiling. Failed, cancelled and uncertain attempts keep their reservations; smaller returned usage does not refund a conservative reservation. Changing a used combined identifier or ceiling is rejected rather than creating another allowance. Preserve the data directory, prior provider grants and historical usage.

Tavily remains separate from Nebius. Its existing cumulative US$10 ceiling includes historical charges; configuring a new Nebius authorization does not reset it or add a new Tavily budget. Current live usage belongs in [RESULT.md](../RESULT.md), not in this setup example.

## Sandbox pricing and execution sublimit

Remote execution additionally requires a bounded sandbox allowance, a verified conservative price and exact approval. Its ceiling is a **sublimit within the combined Nebius build allowance**, not extra money on top of the US$10. Configure it only after explicit authorization and an authoritative maximum charge for the chosen run limits:

| Server setting | Meaning |
| --- | --- |
| `ROS_NEBIUS_SANDBOX_AUTHORIZATION_ID` | Stable identifier for this specific authorization; reuse it across restarts. |
| `ROS_NEBIUS_SANDBOX_MAX_RUNS` | Maximum number of attempts authorized by this allowance. |
| `ROS_NEBIUS_SANDBOX_AUTHORIZED_USD` | Sandbox-only spending sublimit in USD, also constrained by the remaining combined Nebius allowance. |
| `ROS_NEBIUS_SANDBOX_MAX_COST_PER_RUN_USD` | Verified conservative upper bound for all applicable charges for one admitted run. |
| `ROS_NEBIUS_SANDBOX_PRICING_BASIS` | Source and explanation establishing that upper bound, including units and applicable limits. |

All five sandbox fields remain blank/commented in the example configuration. Unset or incomplete settings block execution even when credentials, the combined grant and an inference grant are available. A zero sandbox ceiling is valid only with a documented applicable free allowance; that documentation has not been established. A descriptive pricing-basis string records the operator's evidence; it does not independently verify the provider's rate or impose a billing cap at Nebius. Do not enter an invented rate to make the gate pass.

Each admitted attempt retains its maximum reservation in both the sandbox sublimit and the combined grant after success, failure, cancellation or an uncertain outcome. Retries are new attempts. Neither restarting, switching approval mode, nor changing a grant identifier should be used to replenish an existing allowance. The UI shows the server's admission reason and remaining run/USD allowance; the server checks project limits, sandbox limits and the shared remaining ceiling again when executing. Reservation is local admission accounting, not a Nebius invoice or provider-enforced billing cap.

As of September 22, 2026, the inspected official documentation and signed-in console did not establish a sandbox price, billing unit, or free-beta commitment. The console's Prices filter returned no sandbox price rows; absence of a price is not evidence of free execution. The operation field `resources.cost` has unspecified units and must not be labelled USD without further evidence. Available account credit and historical inference authorization do not establish sandbox spending permission. See the [dated API and pricing investigation](nebius-sandbox-api-research-2026-09-22.md).

## Preview and run

1. Open an Action's experiment dialog and select **Nebius Sandbox · remote Python 3.12 standard library**.
2. Choose a captured dataset or inspect the CSV text. Use non-sensitive data only: Nebius's beta notice excludes personal or sensitive data.
3. Load the selected runtime starter or write compatible Python. Runtime selection preserves existing drafts, so replace or adapt Docker code that uses `df` or scientific libraries.
4. Preview the exact code, CSV and parameters. This saves the capture locally. A configured remote runtime can produce a preview while spending admission remains blocked.
5. Review the external transfer and select **Allow & run** only when all price and allowance gates are ready. It remains disabled under the current unverified-pricing configuration. Every remote attempt requires this explicit decision, including in Approve for me and Full access modes. The legacy local Auto Research group does not include remote attempts.

Execution sends the captured CSV, code and parameters to Nebius Sandboxes. Credentials remain on the application server; original local connection paths are not execution inputs. Nebius may retain request data and operation logs: a disposable sandbox is not a verified remote data-deletion guarantee.

The optional **Plan with Nemotron Ultra** action requires provider inference authorization and reserves against the same combined Nebius build ceiling. It receives the selected dataset and chosen runtime contract, returns proposed code, and does not execute it. A continuous-assistant code proposal likewise consumes inference allowance without authorizing remote execution. Loading a saved plan restores its captured runtime.

## Python contract

`rows` is a list of dictionaries keyed by CSV headers. Cell values are strings, so convert numeric cells explicitly. `params` contains the captured JSON parameters. The output helpers are `table(title, rows)`, `metric(title, value)`, `conclusion(text)`, `export_csv(title, rows)`, and `plot(title, values, labels?)`, which captures a simple SVG plot. The legacy bounded helper `column()` and Docker globals `df`, `pd`, `np`, `plt`, and `scipy` are unavailable.

For a CSV with a numeric `value` column:

```python
import statistics

values = [float(row["value"]) for row in rows]
metric("Mean", statistics.mean(values))
table("First observations", rows[:10])
plot("Observed values", values)
export_csv("Data used", rows)
conclusion("This summarizes the selected observations; it does not explain their cause.")
```

The app captures output helpers, stdout, stderr, exit status and provider operation metadata. Inspect those records to distinguish successful transport from successful Python execution. A preview or offline fixture test does not establish a live remote success.

## Runtime and recovery limits

The adapter requests a disposable remote environment, disabled guest networking, a finite timeout, bounded writable storage and bounded output. The runtime's capability panel reports the actual configured controls and limitations. These are separate from the application's approval and spending policies; local Docker CPU, memory and process limits must not be attributed to Nebius without evidence.

Stop requests provider cancellation. Accepted cancellation is not proof of termination, and lost connectivity can leave the outcome uncertain. The local server records known operation IDs for status reconciliation. It never blindly repeats a create request after an uncertain response. Preserve the original run and inspect its status before an explicit retry.

This setup document describes the integration contract. Check [RESULT.md](../RESULT.md) for the separately recorded live-verification status and any outstanding cost or provider constraints.
