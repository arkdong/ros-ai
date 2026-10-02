# Provider account usage

Implemented September 23, 2026. Account figures are distinct from ros.ai project spending caps, retained app reservations and current provider authorization ceilings.

## Tavily

The server can retrieve authenticated `GET https://api.tavily.com/usage` with its existing server-side `TAVILY_API_KEY`. Enable this explicitly using `ROS_TAVILY_USAGE_SYNC=1`; a credential alone does not enable account queries. The budget route never exposes the credential or raw response. It allowlists key usage/limit, account plan usage/limit, pay-as-you-go usage/limit and per-operation quantities. Quantities stay in credits; they are not converted to a supposed dollar balance or added across overlapping key/account scopes. A missing limit stays unknown.

The shared server cache lasts one minute, coalesces concurrent reads, uses an eight-second request deadline and caps responses at 32 KB. Refresh errors preserve the previous successful snapshot and its original last-refreshed time. Errors and stale snapshots are visible; a failed first request displays no invented balance. Browser refresh reads local accounting and, when enabled and the cache expires, requests fresh provider usage.

The [official usage endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/usage) documents both key and account scopes. Offline tests verify parsing, secret-field exclusion, overlapping scope separation, nullable/zero quantities, coalescing, stale error handling and disabled queries. Initial live verification attempts were rejected by automatic approval review because the supplied delegated approval was not accepted as trusted authorization. Until a subsequent authorized live check succeeds, this must not be described as a verified integration with this account.

## Nebius

No supported public Token Factory balance endpoint was verified by the separate September 23 investigation. [Official billing documentation](https://docs.tokenfactory.nebius.com/other-capabilities/billing-new) describes console balances; model catalog prices and observability are not a remaining-credit API.

The panel reads an optional local `provider-account-report` record with key `nebius`. This is manually reported information with amount, approximate flag, report date and separately nullable observation time. Account values stay in the ignored workspace, not source code. The panel labels its source, never advances a balance-sync timestamp and never subtracts the ros.ai ledger to invent an authoritative balance.

## Narrow Sandbox smoke exception

Adam explicitly authorized a single short beta Sandbox smoke on September 23 despite unverified sandbox pricing. `scripts/verify-nebius-sandbox-once.ts` records that one-use scope durably before submission and refuses another attempt. It uses the production adapter with a five-second execution deadline, non-sensitive integers 1–5, standard-library calculation, a tiny CSV and a disposable instance with networking disabled. It does not modify the normal product's pricing/authorization gates or authorize broader remote work. USD charge and reservation remain unknown; provider raw cost is retained without conversion.

The actual operation completed successfully with the expected stdout, metric and CSV on Python 3.12.13, exit code 0, no timeout and no saved result checkpoint. Live metadata exposed `signal: -1` for no terminating signal; the first adapter incorrectly classified it as failure. The decoder now treats this sentinel correctly and still rejects positive terminating signals. The original immutable run is retained; a distinct, clearly labelled read-only reconciliation validates the same provider operation after the fix, without a second execution. The operation receipt and outputs are saved as native run/artifact records in the ignored workspace. Disposable execution does not establish deletion of provider request/operation logs.
