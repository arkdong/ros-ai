# September 23 three-model comparison authorization

Adam directly authorized running all three models within a US$40 total cap on September 23, 2026. `ComparisonBudget` records a separate fixed-scope grant in the existing workspace database, with US$10 for GPT-5.4, US$20 for Nemotron 3 Ultra and US$10 for Kimi K2.7 Code. Each model has at most two requests. Conservative reservations are retained after success, failure, uncertainty and restart; higher reported estimates also count. There is no release/reset operation. Changing project mappings after first admission blocks further work rather than creating another grant.

The comparison uses the three already prepared projects, exact model selections, a common captured CBS table, reviewed local Docker execution and native model proposal/interpretation paths. The historical September 22 combined Nebius grant is unchanged. Comparison inference records the ordinary provider/project reservations plus this independent comparison admission in the same transaction. Search is disabled while comparison mode is active; remote sandbox permissions and pricing gates remain unchanged.

Enable only for this authorized session, preserving the existing data directory and provider identifiers:

```sh
ROS_MODEL_COMPARISON_AUTHORIZATION_ID=benchmark-20260923-v1
ROS_MODEL_COMPARISON_PROJECTS='{"openai":"e1999329-6044-4ab1-ba81-525289bc8a65","nemotron":"6a0fcbaf-e2b9-4eb4-919e-9c93690b9b9f","kimi":"c8bdf149-f2f1-4012-9642-3f1c4cdf8675"}'
ROS_PAID_AUTHORIZATION_ID=benchmark-20260923-v1-nebius
ROS_NEBIUS_AUTHORIZED_USD=30
ROS_TAVILY_AUTHORIZED_USD=0
ROS_PAID_MAX_REQUESTS=4
ROS_OPENAI_AUTHORIZATION_ID=benchmark-20260923-v1-openai
ROS_OPENAI_AUTHORIZED_USD=10
ROS_OPENAI_MAX_REQUESTS=2
ROS_NEBIUS_COMBINED_AUTHORIZED_USD=0
ROS_NEBIUS_SANDBOX_AUTHORIZATION_ID=
ROS_TAVILY_USAGE_SYNC=0
```

These are process environment assignments, not a replacement credential file. After the six requests or an unresolved failure, disable new paid work and preserve all receipts. Do not retry an uncertain request automatically. The live results belong in `examples/model-comparison-2026-09-23/report.md`; authorization implementation and isolated admission arithmetic are not evidence of completed inference.

## Fresh $90 rerun authorization

Later on September 23, Adam directly requested: “Re run the experiment fast with no unit test and check, given the budget of 90$”. This authorizes one new fixed comparison grant, `benchmark-20260923-v2`, stored under `three-model-comparison-2026-09-23-v2`. The ceiling is **US$90 total**, allocated US$30 per model, with at most two inference calls per model and no automatic retries. The completed v1 grant and its retained reservations remain unchanged in the original record. Arbitrary authorization IDs remain rejected; changing mappings after the first admission still cannot replenish either grant.

The rerun increases the common response cap from 1,400 to **8,000 tokens**, including reasoning where the provider counts it, to allow room for complete interpretations. This is an explicit configuration difference from v1 and must accompany comparisons of its results. The fixed grant exposes `outputTokenCap` for the execution service; provider/project reservation, exact model matching, saved inputs, code approval and isolated execution remain enforced. No unit tests or verification suites are part of this user-requested rerun.

Use the three saved rerun project IDs in the process environment:

```sh
ROS_MODEL_COMPARISON_AUTHORIZATION_ID=benchmark-20260923-v2
ROS_MODEL_COMPARISON_PROJECTS='{"openai":"fa0e3782-0051-4336-b5a7-757f6fbee4e8","nemotron":"316bfb50-4ef6-41e3-ae08-9aa64eb0d4e0","kimi":"b57d0c09-4a35-4f1d-8aa3-09c847697971"}'
ROS_PAID_AUTHORIZATION_ID=benchmark-20260923-v2-nebius
ROS_NEBIUS_AUTHORIZED_USD=60
ROS_TAVILY_AUTHORIZED_USD=0
ROS_PAID_MAX_REQUESTS=4
ROS_OPENAI_AUTHORIZATION_ID=benchmark-20260923-v2-openai
ROS_OPENAI_AUTHORIZED_USD=30
ROS_OPENAI_MAX_REQUESTS=2
ROS_NEBIUS_COMBINED_AUTHORIZED_USD=0
ROS_NEBIUS_SANDBOX_AUTHORIZATION_ID=
ROS_TAVILY_USAGE_SYNC=0
```

These exact ceilings split the one US$90 maximum between Nebius and OpenAI; they are not additional spending authorizations. Retain unknown charges and failed admissions, and disable new paid requests when the six-request rerun finishes or stops. Save the new outputs separately from v1; the grant implementation itself establishes no live result.
