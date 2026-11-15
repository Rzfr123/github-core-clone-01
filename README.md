# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Rzfr123/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Rzfr123/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Standalone GitHub-compatible git forge in one Node 22 process, no UI, no
dependencies, no git binary. Serves git smart HTTP (protocol v2 ls-refs/fetch,
v0 upload-pack/receive-pack), REST v3, GraphQL v4 and MCP from one in-memory
store, so a clone, a push, an issue and a tool call all see the same state.

## Run

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`
and polls `$MAKEFUN_ENV_URL/done` until the suite finishes, then exits 0. It
never binds 8080. The bearer token in `MAKEFUN_SHOP_TOKEN` names the viewer
(`adaiversen`, the suite's seeded token owner); requests without it are 401.

## Layout

- `main.ts` — lifecycle only (starter code, unchanged).
- `app.ts` — HTTP server: REST v3, GraphQL v4, MCP, git routing.
- `git.ts` — pkt-line codec, packfile read/write, smart-HTTP handlers.
- `store.ts` — repositories, git objects, issues, pull requests, merges.

## Behaviour notes

- Repos are created via REST only; a push cannot invent one. Pushes must
  fast-forward per ref (`ng <ref> non-fast-forward`, the ref does not move).
- Contents commits, squash merges and conflict detection are computed from
  the object graph. Shallow fetches honour depth and deepen boundaries.
- GraphQL serves the documents `gh` and `github-mcp-server` send, including
  introspection, cursor pagination, batching and mutations.
- MCP speaks revision 2026-07-28 (`server/discover`) and the legacy
  `initialize` handshake; tools act on the same store as REST.
- No clock or randomness reaches stored state: ids and timestamps derive
  from counters, so replays are deterministic.

## Local check

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:PORT \
  --token "$MAKEFUN_SHOP_TOKEN" --perf
```

Local suite (kit, practice trial-0 seed): 120/120 checks pass —
feature 600, agent 200, perf 164, score 964 (mean of two runs; best 165/965).
Round 2 perf work: fetch-pack memo (identical shallow clones share one pack),
commit-parse memo + known-oid store (no second hash on push), memoized
timestamps/ids, one URL parse per request, memoized single-issue JSON.
