# Responses reasoning recovery cache

Status: ready-for-agent  
Type: spec  
Date: 2026-07-15

## Problem Statement

The rc4 recovery safely completes an old conversation by removing incompatible historical reasoning from a one-time retry payload. It does not mutate the Codex session or remember which reasoning items failed. The next turn therefore sends the same rejected reasoning again, incurs another failed request, removes all reasoning again, and adds the newly generated reasoning to the next failure set. Production logs show removed counts increasing on consecutive turns.

## Solution

Learn fingerprints of the reasoning items removed by a confirmed rc4 recovery. Store only SHA-256 fingerprints in a bounded in-memory registry scoped by stable session identity, model, and subagent identity. Before later upstream attempts in that scope, remove only reasoning items whose fingerprints are already known incompatible. Preserve newly generated reasoning and every non-reasoning request field.

If the prefiltered request still receives the exact ownership error, use the existing one-time recovery, remember the remaining rejected reasoning fingerprints, and retry over HTTP. A process restart or cache eviction may cause one relearning turn but must not corrupt or persist private session content.

## Acceptance Criteria

- The first incompatible turn keeps rc4 behavior: unchanged attempt, exact failure, sanitized HTTP retry, successful completion.
- The second turn in the same scope makes one upstream request after prefiltering known bad reasoning.
- Newly generated reasoning that was not part of the rejected set remains in the second-turn request.
- Removed counts do not grow merely because successful turns add new reasoning.
- Different sessions, models, and subagents do not share learned fingerprints.
- Requests without a stable session ID keep rc4 stateless behavior.
- The registry stores fingerprints only, never encrypted content, item IDs, prompts, or tool data.
- Registry state is bounded to 256 scopes, 2,048 fingerprints per scope, and a 24-hour idle TTL.
- Expired and least-recently-used scopes relearn safely through rc4 recovery.
- Logs expose only a stable reason code and counts.

## Implementation Decisions

- Add one in-process reasoning recovery registry module with a small interface: filter known fingerprints and remember rejected fingerprints.
- Fingerprint `encrypted_content` when present. Fall back to the reasoning item ID when encrypted content is absent; items with neither value are not cached and remain protected by rc4 recovery.
- Propagate a dedicated recovery session ID from the incoming `session-id`/`x-session-id` header. Keep usage/accounting fallback IDs separate, then build a SHA-256 scope key from stable session ID, model, and subagent identity. Do not retain raw scope identity or use the per-turn request ID.
- Apply known-fingerprint filtering before the original HTTP or WebSocket attempt. Clone only when at least one item is removed.
- Record fingerprints immediately before executing the existing sanitized HTTP recovery.
- Preserve the existing exact-error, no-forwarded-frame, cancellation, timeout, and one-retry gates.
- Keep the registry process-local. No config schema or disk persistence is added.
- Prune expired scopes during reads and writes. Update LRU order on access and evict the oldest scope above the limit.
- Cap each scope by evicting the oldest fingerprint above the per-scope limit.
- Log `responses.reasoning_history_prefilter` with reason `known_incompatible_reasoning_history`, removed count, and scope dimensions without raw identity values.

## Testing Decisions

- Test primarily through two sequential `createResponses` calls with fake Copilot HTTP responses.
- First turn must require two requests; second turn must require one and preserve a new reasoning item.
- Add session/model/subagent isolation cases through the same public seam.
- Add no-session and cache-eviction cases without asserting private Map structure.
- Preserve the existing `/responses` handler recovery test and full rc4 suite.
- Run targeted coverage, full tests, typecheck, changed-file lint, root build, desktop server build, and a live two-turn replay using a reconstructed old-session payload.

## Out of Scope

- Persisting fingerprints across process restarts.
- Changing Codex session files.
- Reusing WebSocket connections by session.
- Changing compaction, image processing, model routing, or retry behavior for unrelated errors.
- Enabling npm publishing.

## Further Notes

- A hash registry avoids fragile positional cutoffs when compaction or history ordering changes.
- After a process restart, the first old-session turn can recover exactly as rc4 does; later turns benefit again.
