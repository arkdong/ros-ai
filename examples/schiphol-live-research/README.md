# Schiphol weather · live assistant research

Open the saved project with this title at **http://127.0.0.1:4310**. Project ID: `dfb9b81e-95d1-4a2c-bf5a-d0cb7f51aa09`. This is a guided demonstration of the actual ros.ai application model, with the coding assistant operating the app and approving exact actions. It is not an unattended research success claim.

## Five-minute tour

1. Open **Conversation** on the right. The first actual Ultra response asks a clarifying question. The next proposes four notes with reasons; their accepted proposal and independent relationships remain saved.
2. Open the KNMI Knowledge note. It contains a real 366-row public-weather CSV and one actual Tavily discovery search. Search snippets are partial evidence, including one irrelevant result; they are not a validated literature review. The CSV was imported from the bundled prior public capture, not retrieved autonomously by this model.
3. Open **Monthly Weather Analysis → Experiments**. Inspect the failed file-path attempt, then the repaired model-generated program and completed Docker run `c0c241cc-f133-4cdf-b43b-081152dd2101`. Its monthly table, temperature plot, CSV and metrics are actual outputs. The separate invalid-schema model response applied no tools and remains in conversation/provider evidence.
4. Open **Robustness Check → Experiments**. The app model inspected the first results and proposed reuse. The browser explicitly accepted monthly CSV version `bed64ad7-ff2c-4c1d-a4b8-3fdae3450a28`; a fresh approval captured the changed selected inputs without another model call. Completed run `858a4b52-63c6-4c43-a3b3-a238031e1de7` compares weighting schemes using this exact result. The original stale preview is retained as cancelled.
5. Open **Research outline**. It preserves the original/evolving question, reasons, decisions and actual saved results. Click a metric to inspect its immutable version; focus changes immediately without starting a new conversation. Open **Nebius Sandbox Stdlib Preview → Experiments → Load captured experiment for review** to see the exact remote code/data and blocked approval.

## Observed outputs

| Statistic | Monthly analysis | Follow-up from monthly CSV |
| --- | ---: | ---: |
| Mean temperature, observed-day weighting | 11.970 °C (rounded) | 11.970473 °C |
| Mean temperature, equal-month weighting | — | 11.956083 °C |
| Mean wind, observed-day weighting | 4.894 m/s (rounded) | 4.894426 m/s |
| Mean wind, equal-month weighting | — | 4.899167 m/s |
| Precipitation, trace-as-zero lower bound | 1,047.0 mm | 1,047.0 mm |
| Days with at least 1 mm | 155 / 366 | 0.423497 fraction |

This CSV aggregates KNMI hourly observations into Europe/Amsterdam calendar days. Local days can be 23/25 hours; a mean of daily means is not automatically an hourly-weighted statistic. Monthly exports round means, explaining small differences in recomputation. Trace precipitation was encoded as zero, so the total is a lower bound. The follow-up table repeats aggregate precipitation/fraction under both comparison columns; those rows are not separate weighting methods. No cycling observations, causal result or forecast is claimed. See [source provenance and preparation](../amsterdam-cycling-weather/README.md).

The model's final prose confused several artifact hashes with IDs, which the app rejected as navigable references. Actual execution references in the outline remain available. The final response omitted the requested additional finding/gap memory entries; the outline instead derives its two observed findings from completed executions. Manual clarification annotations are clearly labelled as coding-assistant additions and undoable. Original model responses, code and outputs were not rewritten.

## Execution and spending truth

Six real Ultra requests and one new basic Tavily search ran through ros.ai. Two actual Docker experiments succeeded; the initial Docker experiment failed. The separate uploaded-CSV browser test used the bounded interpreter with explicitly authored code. Remote Nebius execution did **not** run: pricing/free-beta terms remain unverified. Read-only Nebius catalog access and offline adapter tests do not establish remote execution success.

New Nebius estimated token cost: $0.107922. Retained combined reservations: $9.599184 / $10, leaving $0.400816 (not enough for another request's conservative bound). Tavily cumulative retained cost including historical uncertain usage: $0.024 / $10. Paid requests are disabled at handoff; no grant was reset. See [final usage](../../evidence/continuous-collaborator/final-usage.json), [build result](../../RESULT.md) and [sandbox setup](../../docs/nebius-sandbox-setup.md).
