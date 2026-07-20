# Magi Desktop Workbench

Magi Desktop is a local task workspace built on the versioned Magi headless
service. It is intentionally an independent Magi interface: it follows the
project/task workflow that works well for coding agents without copying
proprietary product assets or UI code.

## Current MVP

- Project and task navigation backed by durable Magi sessions
- Background jobs with streamed assistant text
- Activity timeline for agent, tool, approval, and control events
- File-change activity view
- Inline approval and user-question cards
- Model-alias selection
- Job cancellation and reconnecting SSE subscriptions
- Collapsible terminal activity drawer
- Automatic local daemon startup and loopback pairing
- Encrypted device-token persistence through Electron `safeStorage`

The terminal drawer is an agent command/activity view in this version. A
direct interactive PTY is a later milestone and should use a dedicated,
permissioned IPC channel rather than exposing Node APIs to the renderer.

## Process boundary

```text
React renderer (sandboxed)
  | narrow invoke/event IPC
Electron preload (contextBridge)
  | typed MagiDesktopApi
Electron main process
  | MagiHeadlessClient + encrypted pairing token
Magi /v1 service on 127.0.0.1
  | sessions, jobs, tools, permissions, providers, SQLite
Local workspace
```

Provider credentials and Magi pairing tokens never enter the renderer. Folder
selection, daemon lifecycle, HTTP authentication, and SSE reconnects stay in
the main process. Desktop pairing tokens request a one-year lifetime and are
encrypted with Electron `safeStorage`; an authenticated request that receives
HTTP 401 re-pairs and retries once so service restarts and token rotation do not
surface as task failures.

## Develop

From the repository root:

```bash
npm install
npm run build
npm --prefix desktop install
npm run desktop:dev
```

Checks:

```bash
npm run desktop:type
npm run desktop:test
npm run desktop:build
```

The desktop build is written to `desktop/out/`. Run the built app during local
development with:

```bash
desktop/node_modules/.bin/electron desktop
```

## Runtime overrides

| Variable                  | Purpose                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `MAGI_DESKTOP_BASE_URL`   | Override the service URL; defaults to `http://127.0.0.1:8766`    |
| `MAGI_CLI_PATH`           | Point automatic daemon startup at a specific built `dist/cli.js` |
| `MAGI_NODE_PATH`          | Select the Node executable used to start the daemon              |
| `MAGI_DESKTOP_USER_DATA`  | Override Electron user data, useful for isolated tests           |
| `MAGI_DESKTOP_SCREENSHOT` | Capture a post-load PNG and exit for visual QA                   |

The desktop-owned daemon enables arbitrary project directories while remaining
bound to loopback. Remote binding stays an explicit service configuration and
is not enabled by the desktop client.

Port `8766` is reserved for the desktop-owned daemon so an existing CLI or
older Magi service can continue using `8765`. If that port is already occupied,
the desktop client selects and remembers the next available loopback port.
Automatic startup passes the selected port to the daemon.

## Packaging scope

`electron-vite build` currently produces a runnable development distribution,
not a signed standalone `.app`. A signed installer requires bundling the Magi
runtime and native SQLite dependency, rebuilding native modules for the chosen
Electron ABI, code signing, notarization, and update metadata. Those are kept
as a separate release milestone so the service/UI boundary can stabilize first.
