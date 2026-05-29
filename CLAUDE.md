# CLAUDE.md — remote-dj

Collaborative music controller: one **Player** phone plays YouTube, many
**Controller** phones remotely change track / volume / settings in realtime.
Every action is recorded in an Activity Log.

## Tech stack

- **Monorepo**: npm workspaces (`packages/*`, `apps/*`). No build step for shared.
- **packages/shared**: single-file TS package (`src/index.ts`) — protocol
  constants, types, utils. Consumed directly as TS source (no relative imports).
- **apps/server**: Node 22+ authoritative server, Socket.IO, run via `tsx watch`.
- **apps/web**: Next.js 15 (App Router) + React 19 + Tailwind, mobile-first.
  Player uses the YouTube IFrame Player API.

## Directory layout

```
remote-dj/
├── package.json          # workspaces root
├── tsconfig.base.json    # shared compiler options (each pkg sets its own moduleResolution)
├── biome.json            # lint + format
├── vitest.config.ts      # projects discovery + coverage
├── vitest.shared.ts      # shared defineProject base (packages mergeConfig it)
├── docs/                 # SPEC.md (contract), ARCHITECTURE.md, DEPLOYMENT.md
├── packages/shared/      # protocol constants + types + utils
└── apps/
    ├── server/           # Socket.IO authoritative server (tsx)
    └── web/              # Next.js 15 App Router
```

## Commands

- `npm run dev` — run server + web together (concurrently).
- `npm run dev:server` / `npm run dev:web` — run one app.
- `npm run typecheck` — `tsc --noEmit` across workspaces.
- `npm run lint` — `biome check .`
- `npm run format` — `biome check --write .`
- `npm test` — Vitest (root projects config).

## Sync model

The server holds **authoritative state**. Clients apply the `state` the server
broadcasts; no optimistic guessing. On `join`, the joining socket receives the
current `state` + full `activityLog` once. Failed validation returns an error
via the ack only — state/log are left unchanged.

## LOAD-BEARING RULE

Any realtime event must be edited in this order:
**packages/shared (type + constant) → apps/server (handler + validation) →
apps/web (useRoom action).** The contract lives in `docs/SPEC.md`.

## More detail

See `docs/SPEC.md` (protocol contract), `docs/ARCHITECTURE.md` (structure +
RoomStore), and `docs/DEPLOYMENT.md`. Do not inline those here.
