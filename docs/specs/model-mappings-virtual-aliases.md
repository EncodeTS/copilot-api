# Model mappings as virtual model aliases

Status: ready-for-agent  
Type: spec  
Date: 2026-07-16  
Target release: `v2.0.0-rc.11`

## Problem Statement

`modelMappings` currently replaces a model ID only after a request enters the
gateway. The model catalog seen by the client still describes the source model,
while Copilot executes the target model.

For example, after mapping `gpt-5.4-mini` to `gpt-5.6-luna`, Codex may still
construct requests according to mini's context window, compaction threshold,
reasoning levels, tool mode, and behavioral instructions. The gateway
eventually sends those requests to Luna. This creates a mismatch between client
capability awareness, request protocol behavior, and the actual upstream model.
It can cause premature compaction, incorrect long-context rejection, first-turn
Explore failures, and follow-on rollout errors.

Users need `modelMappings` to represent a formal virtual model alias. The source
model should retain only the identity required by the client, the target model
should define actual behavior and runtime capacity, and the mapping layer must
preserve the intent expressed in each client request.

## Solution

When one Copilot model maps to another Copilot model, the gateway will project a
virtual source model to Codex. The virtual model will retain the source model ID
and UI identity, use the target model's complete behavior descriptor from the
current Codex version, and apply the target model's current live Copilot
capabilities.

For a `gpt-5.4-mini` to `gpt-5.6-luna` mapping, Codex will continue to select and
send mini, allowing built-in roles such as Explore to find the expected model
ID. Codex will nevertheless operate with Luna's behavioral instructions, tool
mode, reasoning capability, context window, and compaction threshold. The
gateway will route only the model identity to Luna and will not reinterpret
effort, tools, input, or instruction overrides because a mapping occurred.

The same projection rules and input snapshots will apply to the dynamic Codex
catalog, the Codex startup catalog, and the general model list. Descriptor
output remains specific to the relevant Codex version: a dynamic response uses
the requesting client version, while a proactive startup refresh uses the
newest installed version. Configuration saves, periodic model refreshes, and
Codex catalog requests will safely refresh the startup catalog. An individual
alias that cannot be safely composed will be omitted and the degraded result
persisted. The last-known-good catalog will be retained only when the base
catalog is unavailable or an atomic write fails.

## User Stories

1. As a Codex user, I want a mapped source model to advertise the target model's real capacity, so that Codex does not plan requests using obsolete source limits.
2. As a Codex Explore user, I want the virtual model to retain the source slug, so that built-in roles can continue selecting their expected model ID.
3. As a Codex user, I want the virtual model to retain the source display identity, so that existing UI choices remain stable after a mapping is enabled.
4. As a Codex user, I want the virtual model to use the target model's official behavior descriptor, so that request construction matches the model that actually executes the request.
5. As a Codex user, I want the virtual model to use the target model's base instructions and compatibility hash, so that client and model protocol expectations remain aligned.
6. As a Codex user, I want tool mode, multi-agent behavior, Responses-lite behavior, and shell behavior to come from the target descriptor, so that tool and agent requests use the target model's supported shape.
7. As a Codex user, I want supported reasoning levels to reflect both the target descriptor and live Copilot capabilities, so that Codex offers only currently valid effort choices.
8. As an API client, I want an explicitly supplied reasoning effort to remain unchanged by model mapping, so that the gateway preserves my request intent.
9. As an API client, I want an omitted reasoning effort to remain omitted, so that normal client or bridge defaulting rules still apply.
10. As an API client, I want tools, input, instructions, and per-request overrides to survive mapping unchanged, so that model routing does not alter request semantics.
11. As a long-context Codex user, I want context and prompt limits to come from live target capabilities, so that requests larger than the source limit can use the target model's available capacity.
12. As a Codex user, I want the auto-compaction threshold calculated from live limits, so that future upstream capacity changes apply without a gateway release.
13. As a Codex user, I want the dynamic catalog and next-startup catalog to apply the same virtual-alias rules to their respective Codex versions, so that version-specific descriptors remain correct without changing mapping semantics after restart.
14. As a desktop user, I want new mappings to affect request routing immediately, so that I do not need to restart the gateway.
15. As a desktop user, I want to know when Codex must be restarted, so that updated startup capabilities are actually loaded.
16. As a desktop user, I want a catalog refresh failure reported separately from configuration save success, so that I do not mistake a partial success for a lost mapping.
17. As an operator, I want the startup catalog refreshed after live Copilot models change, so that long-running gateways do not retain stale capacities or endpoints.
18. As an operator, I want concurrent refreshes to use latest-wins ordering, so that an older asynchronous refresh cannot overwrite a newer mapping.
19. As an operator, I want each projection to use one immutable mapping and live-model snapshot, so that one catalog never mixes multiple configuration revisions.
20. As an operator, I want an unavailable or disabled target omitted from advertised aliases, so that clients do not select a model the gateway cannot serve.
21. As an operator, I want a target without a supported Responses transport omitted from the Codex catalog, so that the catalog does not advertise an unusable model.
22. As an operator, I want a missing or incompatible target descriptor to remove the unsafe alias, so that the source descriptor is never presented as though it described the target.
23. As an operator, I want a degraded but valid catalog persisted, so that stale aliases are removed rather than retained indefinitely.
24. As an operator, I want the last-known-good file preserved when the base catalog cannot be generated or an atomic write fails, so that startup is not broken by a transient failure.
25. As an operator, I want mapping deletion to restore the real source descriptor and live source limits, so that rollback is predictable.
26. As a configuration editor, I want self-mappings, chains, and cycles rejected, so that every mapping has an unambiguous one-hop meaning.
27. As a configuration editor, I want whitespace-only values and unsafe object keys rejected, so that malformed mappings cannot enter runtime state.
28. As an operator who edits configuration manually, I want an invalid mapping set disabled with a structured diagnostic, so that malformed disk state does not activate partially.
29. As a non-Codex model-list client, I want the source ID to expose target operational capabilities, so that discovery agrees with actual routing.
30. As a non-Codex model-list client, I want both the virtual source alias and real target entry retained, so that either model ID remains discoverable.
31. As a provider-model user, I want existing `provider/model` request routing to continue working, so that this feature does not regress custom providers.
32. As a provider-model user, I do not want fabricated Codex capabilities without a standardized provider descriptor, so that discovery remains trustworthy.
33. As a caching client, I want ETags to change only when the effective Codex catalog body changes, so that conditional requests remain semantically correct.
34. As a release operator, I want the change delivered in a new release candidate without moving an existing tag, so that published artifacts remain immutable.

## Implementation Decisions

- The existing Codex model projection module is the primary module and highest
  test seam. It will own source and target resolution, descriptor composition,
  live capability application, reasoning-level validation, omission
  diagnostics, and projection status.
- The projection interface will receive the client version, live Copilot model
  snapshot, and mapping snapshot explicitly. It must not re-read global
  configuration during asynchronous generation.
- Projection will return the effective Codex catalog, structured omission
  diagnostics, and one of three outcomes: `complete`, `degraded`, or
  `unavailable`.
- `complete` means every applicable alias was safely projected. `degraded`
  means the base catalog is valid but one or more aliases were deliberately
  omitted. `unavailable` means no trustworthy base catalog could be produced.
- Both `complete` and `degraded` catalogs are eligible for persistence.
  `unavailable` preserves the last-known-good file.
- A virtual Codex descriptor starts from the complete target descriptor. A
  narrow allowlist of source identity fields is then overlaid: slug, display
  name, description, priority, and visibility. This default-to-target rule
  ensures newly introduced behavior fields do not silently remain tied to the
  source model.
- Target-owned fields include base instructions, compatibility hash, tool mode,
  multi-agent version, Responses-lite mode, shell behavior, input modalities,
  API support, and all otherwise unknown behavioral descriptor fields.
- Context window and maximum context window come from target live capabilities.
- A mapped alias without a positive, safe target context-window limit is
  omitted as degraded because the gateway cannot advertise trustworthy
  capacity.
- Auto-compaction remains dynamically calculated as the minimum of ninety
  percent of the target context window and the target prompt limit minus 32,000
  tokens of headroom. No model-specific constants will be added.
- When live capabilities omit a valid prompt limit, prompt capacity falls back
  to the positive difference between context and output limits, matching the
  existing projection behavior. When the output limit is also absent, it is
  treated as zero for this fallback. The ninety-percent context limit still
  provides the upper safety bound.
- Supported reasoning levels retain target descriptor ordering and descriptions
  but are validated against target live reasoning-effort values when that
  capability is explicitly present. When live capabilities omit the field, the
  descriptor remains authoritative.
- If explicit live reasoning capabilities have no valid intersection with the
  descriptor, or the target descriptor's default effort is no longer valid,
  the alias is omitted and reported as degraded.
- Request mapping changes only model identity. Native Responses requests do not
  gain, lose, or translate reasoning effort because of mapping. Existing
  Messages bridge behavior remains unchanged and runs after identity resolution
  according to its current rules.
- A Codex alias may exist when the source is absent from the live Copilot list,
  provided the source descriptor exists and the target is valid. This supports
  virtual role IDs such as mini.
- A Copilot target must exist in the current live catalog, be picker-enabled,
  and support the currently enabled HTTP or WebSocket Responses transport.
- A target with a provider-qualified ID remains routable for requests but is
  not projected into Codex capabilities until provider capability and
  descriptor contracts are standardized.
- Configuration validation is centralized in the configuration module and
  shared by the admin route and runtime loading. Source and target values must
  be non-empty and not whitespace-only; values are not silently trimmed or
  case-normalized.
- Mapping semantics are strictly one hop. A source cannot map to itself, and no
  target may also appear as a source in the same mapping set. This rejects
  chains and cycles without recursive resolution.
- Mapping dictionaries must be handled through safe records or maps so special
  keys cannot alter object prototypes.
- An invalid mapping set submitted through the admin interface returns an
  invalid-request response and is not written. An invalid mapping set found on
  disk is disabled as a whole and emits a structured diagnostic rather than
  partially activating.
- Startup-catalog refreshes from configuration saves, live-model refreshes, and
  Codex model requests share one serialized coordinator. A monotonically
  increasing input revision belongs to a mapping or live-model snapshot change,
  not to an observation request. Multiple observations of the same snapshots
  share the same input revision.
- Persistence ordering has two independent guards. A result for an older input
  revision cannot replace a newer input revision, and a catalog generated for
  an older Codex version cannot replace an existing catalog generated for a
  newer Codex version. A newer input revision does not bypass the Codex-version
  guard.
- A refresh superseded by a newer input revision completes without writing and
  reports a structured `superseded` reason. Repeated Codex model requests do not
  advance the input revision and therefore cannot starve configuration or live
  model refreshes.
- The model-cache module will expose a refresh completion hook or equivalent
  orchestration seam instead of directly depending on Codex persistence.
- Initial Copilot model loading, each successful periodic model refresh, each
  mapping addition, modification, or deletion, and each valid Codex
  `/v1/models` request trigger startup-catalog observation.
- The existing atomic temporary-file, readback validation, permission setting,
  rename, and cleanup implementation remains the persistence adapter.
- A valid degraded catalog replaces the previous startup file so invalid or
  unavailable aliases are removed. Only projection unavailability or
  persistence failure preserves the previous bytes.
- The admin save response reports the saved mapping snapshot and catalog refresh
  outcome separately. Refresh outcome distinguishes updated, unchanged,
  skipped, and failed; it also reports whether a Codex restart is required and
  whether projection was degraded. A skipped outcome includes a stable reason
  such as superseded input, older Codex version, or unavailable installed
  client.
- Configuration persistence success is not rolled back when catalog refresh
  fails. The route returns success with a failed refresh status because new
  request routing is already active.
- The desktop adapter returns the admin response body to the renderer instead
  of discarding it. The renderer displays success, restart-required, degraded,
  and refresh-failed states distinctly.
- The desktop request timeout is long enough to cover first-time Codex
  executable discovery and catalog generation.
- For non-Codex `/v1/models`, projection occurs on raw Copilot models before
  client normalization. An existing source model retains source-owned identity
  fields, including ID, name, display name, object identity, and preview
  identity. It receives target-owned operational fields: capabilities,
  supported endpoints, vendor, and version.
- General model projection returns new model objects and does not mutate the
  live `state.models` snapshot or nested target capability objects.
- The general model list does not synthesize a source entry absent from the live
  Copilot catalog, and it does not fabricate capabilities for
  provider-qualified targets.
- The real target entry remains present alongside the virtual source entry.
- Codex ETags continue to hash the effective response body. They change when an
  effective alias changes and remain stable for mappings that do not affect
  that Codex catalog.
- Catalog refresh diagnostics must be structured and content-safe. Expected
  omissions use debug or warning events without logging descriptor contents,
  request contents, or credentials.

## Testing Decisions

- Tests assert behavior through the highest available seams: the Codex
  projection interface, startup-catalog manager interface, HTTP model and
  configuration routes, request handler interface, and desktop IPC and renderer
  interface. Internal helpers are not test surfaces.
- The primary regression test configures mini to Luna and observes a mini slug
  with Luna behavior fields, Luna reasoning levels, a 1,050,000-token context
  window, and an 890,000-token auto-compaction limit.
- Projection tests verify source identity preservation, target behavior
  ownership, live-limit application, unknown target-field preservation, and
  restoration after mapping removal.
- Projection tests verify explicit live reasoning-level intersection,
  descriptor fallback when live reasoning metadata is absent, and degraded
  omission when live and descriptor reasoning contracts are incompatible.
- Request-handler tests verify that model ID changes while explicit low, medium,
  high, xhigh, and max efforts remain unchanged, and that an omitted native
  Responses effort remains omitted.
- Request-handler tests verify tools, input, instructions, and overrides are not
  modified by the mapping layer.
- Validation tests cover empty values, whitespace-only values, self-maps,
  chains, cycles, duplicate sources, and prototype-sensitive keys.
- Runtime configuration tests verify an invalid on-disk mapping set is disabled
  atomically rather than partially activated.
- Projection tests cover missing target models, disabled targets, targets
  without Responses, provider-qualified targets, and missing target
  descriptors.
- Startup persistence tests verify both complete and degraded catalogs replace
  the prior file, while unavailable generation and atomic-layer failures
  preserve exact previous bytes.
- Startup persistence tests retain existing cross-platform temporary-file,
  validation, and rename coverage, including macOS and Windows path behavior.
- Concurrency tests deliberately complete an older refresh after a newer refresh
  and verify latest-input-wins persistence.
- Version-ordering tests verify that an older Codex client request cannot
  replace a startup catalog produced for a newer Codex version, including when
  the older request observes a newer mapping or live-model input revision.
- Observation tests verify repeated `/v1/models` requests against unchanged
  snapshots reuse the current input revision and cannot starve a pending
  configuration refresh.
- Snapshot tests issue rapid consecutive configuration saves and verify each
  response and persisted catalog correspond to the correct immutable revision.
  A superseded save reports that reason without writing stale catalog bytes.
- Refresh-loop tests verify each successful live model refresh invokes catalog
  observation and each failed refresh preserves both the previous live snapshot
  and startup catalog.
- HTTP model-route tests verify dynamic Codex projection, 304 handling,
  effective-body ETag changes, and ETag stability for irrelevant provider
  mappings.
- General model-route tests verify the source ID retains its identity, exposes
  target operational capabilities, keeps the real target entry, and leaves
  absent sources and provider targets unsynthesized. They also verify the
  original live model snapshot and nested capabilities remain unchanged.
- Live-limit tests verify that an invalid or missing context limit omits the
  alias as degraded, while missing prompt and output limits use the documented
  safe fallback.
- Admin-route tests verify configuration success with updated, unchanged,
  degraded, and failed catalog refresh outcomes.
- Desktop tests verify the IPC response is preserved and the renderer shows
  immediate-routing, restart-required, and partial-failure messages correctly.
- Existing Codex client-model response tests are prior art for descriptor and
  live-capability projection.
- Existing startup-catalog tests are prior art for last-known-good validation
  and atomic persistence.
- Existing model-route tests are prior art for ETag and User-Agent-specific
  catalogs.
- Existing configuration-route and model-mapping editor tests are prior art for
  save validation and desktop behavior.
- Existing Responses and Messages flow tests are prior art for preserving
  explicit reasoning intent.
- Release verification includes a real supported Codex canary request using
  mini with medium effort and confirming Luna is sent upstream, a synthetic
  input above the old mini prompt limit but below Luna's prompt limit, and a
  newly created Explore task without the prior rollout failure.
- Targeted tests, the full test suite, typecheck, lint, server build, and desktop
  build must pass before release.

## Out of Scope

- Multi-hop, recursive, or conditional model mappings.
- Automatic effort translation, downgrade, or default changes caused
  specifically by model mapping.
- A new parallel model-catalog subsystem.
- Hard-coded mini or Luna context and compaction constants.
- Fabricating Codex descriptors or capabilities for provider-qualified targets.
- Automatically restarting a running Codex client.
- Changing existing Claude Code Messages bridge defaults or reasoning-budget
  translation.
- Removing the real target model from any model list.
- Moving or rewriting an already published release tag.

## Further Notes

- The intended release is `v2.0.0-rc.11`; the existing `v2.0.0-rc.10` tag
  remains immutable.
- Existing configurations that satisfy the one-hop validation rules require no
  migration. A previously configured mini-to-Luna mapping gains virtual-alias
  behavior after upgrading. Legacy mapping sets that violate the new rules are
  disabled as a whole and reported through structured diagnostics.
- Request routing becomes effective immediately after configuration save.
  Codex startup capabilities take effect after the startup catalog is refreshed
  and Codex is restarted.
- The defining invariant is: source identity lets the client find the role,
  target behavior describes how the real model must be called, target live
  capabilities describe what is currently available, and each request's
  explicit intent remains owned by the client.
