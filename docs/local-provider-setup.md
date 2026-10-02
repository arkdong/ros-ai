# Local provider setup

> Historical credential/setup record. Current Ultra compatibility, fresh authorization requirements and new evidence are in [next-provider verification](next-provider-verification.md). Existing credential files were not overwritten by the next build.

Verified September 20, 2026. This records developer tooling and credential setup, not a working ros.ai application integration.

## Tavily

- Official Tavily CLI installed: version 0.1.8, managed through the existing uv tool environment.
- Eight official Tavily skills installed globally for Codex. New-session discovery or restart/rescan is required; automatic activation in the already-open session was not verified.
- CLI authentication returned authenticated with an API key.
- One live basic Tavily search returned one result. The CLI did not report credits or dollar cost; do not report this call as free or a measured charge.
- The supplied credential is saved in the CLI's user configuration and this repository's `.env.local` as `TAVILY_API_KEY`. Both files have owner-only permissions; `.env.local` is ignored by Git.
- The key is deliberately absent from this document, the build prompt, and `.env.example`.

The future ros.ai backend must explicitly load the ignored environment configuration and call Tavily through the official SDK or REST API. Installing the CLI does not implement the application's search adapter. Never use a browser-exposed environment-variable prefix for the key.

The one-time Tavily verification ceiling remains US$10. Funding and remaining account credits have not been checked; account for this setup request when reconciling usage.

## Nebius

The supplied Nebius key is stored as `NEBIUS_API_KEY` in the same owner-only, ignored `.env.local`. Markdown punctuation escapes in the supplied text were normalized before storage. Authentication was verified against the official model catalog: the authenticated request returned 24 models; an unauthenticated control was rejected. No inference request was sent, so model generation, tool calling, structured output, pricing, and available balance remain unverified.

The intended one-time build verification ceiling remains US$20. The current official API base is `https://api.tokenfactory.nebius.com/v1/`, verified against the [Nebius quickstart](https://docs.tokenfactory.nebius.com/quickstart). Select and verify an appropriate model during implementation; catalog availability alone is not hackathon approval.

## References

- [Official setup skill](https://tavily.com/agent-setup/SKILL.md)
- [Official agent skills](https://github.com/tavily-ai/skills)
- [Foundation milestone](foundation-milestone.md)

## Application integration follow-up — September 21

The above records the earlier setup checks. The foundation now includes working server-side adapters and bounded live integration verification: six Nebius requests and one additional Tavily basic search. See [RESULT.md](../RESULT.md) for exact totals and evidence, and [provider verification](provider-verification.md) for catalog capabilities, current pricing, conservative accounting and uncertainty. No key values or account changes are recorded here.
