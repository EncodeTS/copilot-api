# Responses WebSocket continuation compatibility

Status: ready-for-agent  
Type: spec  
Date: 2026-07-15

## Problem Statement

When a Codex user resumes an older conversation, the replayed history can contain opaque encrypted reasoning items produced by several earlier model requests and upstream connections. Copilot rejects some of those reasoning items with `input item does not belong to this connection`. The failure occurs on both WebSocket and HTTP upstream transports. On WebSocket, the proxy forwards an HTTP 200 stream that ends without a Codex-acceptable successful outcome, so Codex reports a generic reconnecting error instead of completing the turn.

The failure is deterministic for a reconstructed old-session history containing many encrypted reasoning items. Replaying the full history fails identically over WebSocket and HTTP. Removing every historical reasoning item while preserving messages, function calls, function outputs, custom tool calls, and custom tool outputs makes the same request complete successfully over both transports. Removing item IDs alone does not help. Individual old messages, reasoning items, and function calls can succeed, so the incompatibility is an opaque multi-turn reasoning-state problem rather than a generic item-ID problem.

The current implementation has no recovery path for this upstream validation failure. WebSocket error events are treated as terminal and HTTP non-success responses are thrown immediately. Neither path can retry a semantically equivalent request with incompatible reasoning state removed. The WebSocket pool also uses a request-derived key rather than stable session identity, which remains a performance and affinity concern but is not sufficient to repair already incompatible old reasoning history.

This is a proxy compatibility defect. It is not conversation corruption, an image compression issue, or a context compaction threshold issue.

## Solution

Preserve every request exactly on its first upstream attempt. Introduce a narrow history-recovery policy that recognizes the exact Copilot error `input item does not belong to this connection`, verifies that the request contains historical reasoning items, verifies that no semantic output has reached the client, removes only top-level reasoning items from a cloned payload, and retries exactly once over HTTP.

Apply the same policy when the original transport is HTTP and returns the exact validation error before streaming begins. This makes the recovery work while WebSocket is disabled as an operational mitigation. Never retry unrelated errors, requests without reasoning history, already-sanitized attempts, cancellations, or failures after semantic output.

Ensure every streaming path ends in a protocol-valid terminal outcome. An unrecoverable upstream rejection must become a structured failure that Codex understands rather than a successful HTTP stream that simply closes without completion.

This specification delivers the correctness fix: exact upstream error classification, reasoning-history sanitization, one safe HTTP retry, structured terminal errors, deterministic regression tests, and observability. Session-aware WebSocket pooling is a separate follow-up optimization and is not required to ship this fix.

The existing WebSocket configuration flag remains the operator-level master switch. It stays disabled in affected installations until the correctness phase is released and validated.

### Acceptance criteria

- A resumed Codex conversation containing incompatible encrypted reasoning history completes through one sanitized HTTP retry without a reconnect loop.
- A portable new conversation continues to use WebSocket when the feature is enabled and the model advertises WebSocket support.
- A proxy restart followed by continuation of an existing conversation either succeeds unchanged or recovers by removing only historical reasoning items.
- A WebSocket disconnect followed by continuation either reuses only valid connection state or selects HTTP.
- The exact upstream connection-ownership rejection is retried over HTTP at most once and only before semantic output.
- A failure after semantic output is not retried and is surfaced as a structured terminal error containing the upstream cause when available.
- The client never receives a stream that silently ends without a recognized terminal outcome.
- Existing image optimization, compaction ownership, model routing, web search, subagent routing, and provider behavior remain unchanged.

## User Stories

1. As a Codex user, I want to resume an old conversation, so that I can continue useful work without creating a new task.
2. As a Codex user, I want a resumed conversation to work after upgrading the proxy, so that protocol changes do not invalidate my history.
3. As a Codex user, I want a conversation to survive a proxy restart, so that routine configuration changes do not strand active work.
4. As a Codex user, I want a conversation to survive an upstream WebSocket disconnect, so that transient network events do not permanently break the task.
5. As a Codex user, I want new portable conversations to retain WebSocket performance, so that the compatibility fix does not disable the optimized path globally.
6. As a Codex user, I want incompatible encrypted reasoning history removed transparently only after the upstream proves it is unusable, so that portable history is preserved by default.
7. As a Codex user, I want terminal failures to contain the real upstream cause, so that I do not see only a generic stream-disconnected message.
8. As a Codex user, I want retries to avoid duplicate model output, so that a transport fallback cannot repeat text or tool calls.
9. As a Codex user, I want tool calls from a continued conversation to execute at most once, so that transport recovery cannot duplicate side effects.
10. As a Codex user, I want context compaction to remain client-owned when configured that way, so that this fix does not change conversation retention policy.
11. As a Codex user, I want image limits and compression behavior to remain unchanged, so that a transport fix does not regress visual prompts.
12. As a proxy operator, I want the WebSocket flag to remain a master switch, so that I can choose the conservative HTTP-only mode during rollout.
13. As a proxy operator, I want automatic transport decisions to include a safe reason code in logs, so that I can understand why a request used HTTP.
14. As a proxy operator, I want logs to avoid item IDs and conversation content, so that diagnostics do not expose private session data.
15. As a proxy operator, I want a request to fall back at most once, so that an upstream incompatibility cannot create a retry loop.
16. As a proxy operator, I want HTTP fallback to preserve request cancellation and timeout behavior, so that abandoned turns stop promptly.
17. As a proxy operator, I want rate-limit and usage accounting to count the successful generation exactly once, so that fallback does not inflate usage reporting.
18. As a proxy operator, I want subagent traffic isolated from the main conversation connection, so that concurrent agents cannot consume each other's connection-bound items.
19. As a proxy operator, I want concurrent requests in one session handled conservatively, so that a second active request is never attached to an incompatible connection.
20. As a maintainer, I want transport selection expressed through one small interface, so that compatibility rules are not duplicated across route handlers and upstream clients.
21. As a maintainer, I want history recovery gated by an exact upstream error and the presence of reasoning items, so that unrelated validation failures are not hidden.
22. As a maintainer, I want fully materialized items with IDs to remain portable, so that the proxy does not unnecessarily force all historical traffic to HTTP.
23. As a maintainer, I want reasoning removed only after a confirmed ownership rejection, so that healthy encrypted history remains untouched.
24. As a maintainer, I want HTTP and WebSocket failures normalized consistently, so that recovery rules cannot drift by transport.
25. As a maintainer, I want process restart continuations covered by recovery tests, so that stale encrypted state does not strand a conversation.
26. As a maintainer, I want deterministic fake upstream adapters, so that connection-affinity behavior can be tested without consuming Copilot quota.
27. As a maintainer, I want the regression fixture minimized and synthetic, so that tests preserve the protocol shape without committing private conversation data.
28. As a maintainer, I want the original client-visible failure asserted at the highest seam, so that future refactors cannot reintroduce a stream without a terminal outcome.
29. As a maintainer, I want lower-level pool tests to cover idle close, disconnect, and concurrency, so that the optimization phase remains independently verifiable.
30. As a release owner, I want the correctness phase released before session-level pooling optimization, so that a performance enhancement cannot delay the user-facing fix.
31. As a release owner, I want old-session, new-session, and post-restart smoke scenarios, so that the release decision is based on all affected lifecycle states.
32. As a release owner, I want WebSocket re-enabled only after the compatibility matrix passes, so that users do not need to choose between performance and reliable continuation.

## Implementation Decisions

- Introduce a deep reasoning-history recovery module whose interface accepts the original normalized Responses payload, a normalized upstream failure, the original transport, and whether semantic output has been exposed. It returns either no recovery or a single sanitized HTTP retry plan. Callers do not implement sanitization or retry eligibility themselves.
- Preserve the original request unchanged on the first attempt. Do not proactively remove reasoning from healthy conversations.
- Classify recovery only when the normalized upstream message exactly identifies input ownership by another connection, the payload has an array input containing at least one top-level reasoning item, the attempt has not already been recovered, the caller has not cancelled, and no semantic output was exposed.
- Create the retry payload by cloning the original payload and removing top-level items whose type is `reasoning`. Preserve all messages, phases, tool calls, call identifiers, tool outputs, custom tool traffic, instructions, tools, model parameters, metadata, image content, and context-management settings.
- Retry the sanitized payload once over HTTP regardless of whether the original attempt used WebSocket or HTTP. HTTP is the recovery transport because it has no live connection to reuse and was validated successfully with the sanitized full history.
- Preserve the existing rule that explicit compaction requests use HTTP.
- Preserve model capability gating: WebSocket remains unavailable when the selected model does not advertise it or when the operator flag is disabled.
- Normalize HTTP error bodies and WebSocket terminal error frames into one upstream-failure shape containing status, code, and message.
- Extend stream state so the recovery layer can distinguish a request that was never sent, an upstream rejection before semantic output, a failure after semantic output, caller cancellation, and timeout.
- Inspect a terminal upstream error frame before forwarding it. The exact connection-ownership rejection is eligible for one sanitized HTTP retry only when no semantic output has been exposed.
- Do not retry after text deltas, reasoning deltas, tool-call deltas, completed output items, or any other semantic output. This invariant prevents duplicate generations and duplicate side effects.
- If only non-semantic setup frames precede an eligible rejection, either buffer those frames until transport commitment or treat them as making fallback unsafe. The implementation must choose one rule and cover it with an external behavior test; buffering is preferred when bounded to the initial handshake.
- When fallback succeeds, expose only the HTTP attempt's stream to the client. The rejected WebSocket attempt must not leak duplicate lifecycle frames.
- When fallback is not eligible or also fails, emit one structured terminal error containing the normalized upstream cause. Do not close a nominally successful stream without a terminal outcome.
- Carry cancellation, timeouts, session identity, initiator, subagent identity, authentication, and usage-recording context unchanged across an eligible fallback.
- Count usage from the successful terminal response only. Record the rejected pre-output attempt as a transport diagnostic rather than a completed generation.
- Keep input classification and recovery logging free of conversation content, item identifiers, and encrypted reasoning content.
- Keep the existing configuration schema. No config migration is required for the correctness phase, and recovery must work with WebSocket either enabled or disabled.
- Keep WebSocket disabled in the affected local deployment until a release containing the correctness phase passes the compatibility matrix.
- Update operator documentation to explain the one-time reasoning-history recovery and why it is intentionally narrow.

## Testing Decisions

- Use the externally observable `/responses` handler as the primary seam for the active HTTP configuration and client-visible terminal stream. Exercise WebSocket-specific recovery through the public Copilot Responses client seam with a fake external WebSocket and HTTP adapter, avoiding a second route-level WebSocket harness that would duplicate transport infrastructure.
- Test through the shared recovery behavior for the classification matrix, but avoid asserting private helper structure.
- Extend existing Responses handler and WebSocket pool test patterns rather than creating a second transport test framework.
- Add a red regression case with a synthetic history containing multiple opaque reasoning items modeled after the minimized resumed-session capture. It must produce the original upstream error before the fix and one completed sanitized HTTP response after the fix.
- Add a portable full-message case containing an ID and assert that sanitization preserves it unchanged.
- Add a sanitized-payload assertion proving that only reasoning items are removed and every other input item and request field is preserved.
- Add a WebSocket-first case at the public Copilot Responses client seam where the first terminal frame is the exact connection-ownership rejection, no semantic output is observed, sanitized HTTP succeeds, and the caller receives one coherent completed stream.
- Add an HTTP-first case where the upstream returns the exact validation error, sanitized HTTP succeeds, and the client receives the successful retry.
- Add cases proving that unrelated 400 and 404 errors, exact errors without reasoning history, and already-recovered attempts are not retried.
- Add a case where a text or tool-call delta precedes the same rejection and assert that HTTP is not retried.
- Add a case where HTTP fallback also fails and assert one structured terminal failure rather than a silent close or retry loop.
- Preserve the existing WebSocket cancellation and timeout suite, and add error-body abort and timeout cases around HTTP failure classification.
- Add safe-log assertions proving that reason codes are present while item IDs and prompt content are absent.
- Run the focused transport, Responses handler, and WebSocket pool tests first, followed by the full test suite, typecheck, lint, and production build.
- Validate the packaged desktop build because the reported workflow uses the packaged server and its restart lifecycle.
- Run a live smoke using a reconstructed old-session payload and assert that the unchanged first request fails, the sanitized HTTP retry succeeds, and the final stream contains `response.completed`.

## Out of Scope

- Changing Codex's local session format or how it persists opaque reasoning items.
- Changing the GitHub Copilot upstream WebSocket protocol.
- Reconstructing complete historical items from Codex session files inside the proxy.
- Persisting WebSocket connection provenance across process restarts.
- Changing context compaction ownership or thresholds.
- Changing image payload budgets, image compression, or vision limits.
- Changing model mappings, reasoning effort defaults, web-search routing, provider translation, or authentication.
- Retrying failures after semantic output has been delivered.
- General retry handling for unrelated upstream validation or model errors.
- Session-aware WebSocket pool keys, connection epochs, item provenance tracking, and concurrent-session connection reuse. These are a separate optimization after the correctness fix.
- Enabling WebSocket by default before the compatibility matrix passes.
- Committing private session captures, item identifiers, prompts, credentials, or local filesystem paths as fixtures.

## Further Notes

- The immediate operational mitigation is to keep upstream Responses WebSocket disabled. This affects only the proxy-to-Copilot transport; Codex-to-proxy WebSocket support remains independently configured.
- The repository remote is the EncodeTS fork, but the current checkout is an archived pre-release state with a large unrelated diagnostic modification. Implementation should begin in a clean linked worktree based on the current release branch while preserving the existing checkout unchanged.
- This correctness fix should be the next release candidate's blocking fix. Session-aware pooling is valuable but must not block conservative HTTP compatibility.
- A session identifier alone does not make old references valid after reconnect. Provenance belongs to a specific live connection epoch.
- The reviewed live reproduction demonstrated that transport switching alone is insufficient: the original full history fails over both HTTP and WebSocket, while the same history without reasoning succeeds over both. The correctness fix therefore belongs in shared history recovery rather than WebSocket-only routing.
- Session-aware WebSocket pooling remains a separate optimization. It must not be presented as recovery for already incompatible encrypted reasoning history.

## Comments

- Initial specification synthesized from a live rc3 diagnosis and minimized local replay on 2026-07-15. No private session data is included.
