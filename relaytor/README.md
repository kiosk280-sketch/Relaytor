# Relaytor

**A local control layer connecting web-based AI conversations to a local coding agent.**

Relaytor lets you send selected task text from supported AI websites to an agent on your own machine. A Chrome extension submits the task to Relaytor Core, a small HTTP service bound to loopback; a local agent claims the task and reports its result.

Relaytor addresses the gap between an AI conversation in a browser and a local agent without requiring a cloud relay, user accounts, or a native IDE integration.

> Web AI conversation → Chrome extension → Relaytor Core → local agent → Relaytor Core → browser

The Phase 1 implementation is released as **v1.0.0** (`f54cb53`). Phase 2 focuses on packaging and distribution readiness; the implementation remains within the Phase 1 boundaries below.

## Supported websites

The extension currently runs on:

- ChatGPT (`chatgpt.com`)
- Claude (`claude.ai`)
- Google Gemini (`gemini.google.com`)
- Mistral (`chat.mistral.ai`)

The extension adds a **Send to Relaytor** button to supported pages. Select the task text you want to send, then use the button. Relaytor does not automatically read or submit the rest of the conversation.

## Architecture

```text
┌───────────────────────────────┐
│ Supported AI website          │
│ ChatGPT · Claude · Gemini     │
│ Mistral                       │
└───────────────┬───────────────┘
                │ Selected task text
                ▼
┌───────────────────────────────┐
│ Chrome extension              │
│ UI, local token, task polling │
└───────────────┬───────────────┘
                │ HTTP + bearer token
                ▼
┌───────────────────────────────┐
│ Relaytor Core                 │
│ 127.0.0.1:5000                │
│ FIFO queue · in-memory state  │
└───────────────┬───────────────┘
                │ Claim and report status
                ▼
┌───────────────────────────────┐
│ Local reference agent         │
│ Demonstrates the agent API    │
└───────────────┬───────────────┘
                │ Result
                └──────────────→ Core → extension status
```

Core, the extension, and the agent communicate over HTTP on the same machine. There is no cloud service or remote task storage in this release.

## Requirements

- Node.js 18 or newer
- Google Chrome or a Chromium-based browser
- One of the supported AI websites

Relaytor Core and the reference agent use only Node.js built-in modules. No `npm install` step is required.

## Installation and setup

Clone the repository and open a terminal in its root:

```bash
git clone https://github.com/kiosk280-sketch/Relaytor.git
cd Relaytor
```

### Start Relaytor Core

From the repository root, run:

```bash
node relaytor/server/relaytor-core.js
```

Core listens on `127.0.0.1:5000`. On first startup it generates a bearer token, saves it to `relaytor/server/config.json`, and prints it in the Core terminal. Keep the token private. The ignored config file preserves the token for subsequent starts; do not add it to Git or share it.

Keep Core running while using the extension and agent.

### Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `relaytor/extension/` directory.

The extension is not currently distributed through the Chrome Web Store.

### Configure the extension

1. Open the Relaytor extension popup.
2. Paste the token printed by Core into **Relaytor Core token**.
3. Select **Save token**.

The extension stores the token in Chrome's local extension storage and sends it to Core as a bearer token. Do not publish it, put it in source code, or commit it.

### Run the reference agent

The reference agent demonstrates the protocol; it is not an IDE agent and does not modify a software project. First submit a task from a supported website, then run the agent from the repository root. It claims one pending task per run.

PowerShell:

```powershell
$env:RELAYTOR_TOKEN = "<token printed by Relaytor Core>"
node .\relaytor\agent\test-agent.js --mode=completed
Remove-Item Env:RELAYTOR_TOKEN
```

To demonstrate a failed task, submit another task and run:

```powershell
$env:RELAYTOR_TOKEN = "<token printed by Relaytor Core>"
node .\relaytor\agent\test-agent.js --mode=failed
Remove-Item Env:RELAYTOR_TOKEN
```

On macOS or Linux, set the environment variable for the process:

```bash
RELAYTOR_TOKEN="<token printed by Relaytor Core>" node ./relaytor/agent/test-agent.js --mode=completed
```

The reference agent simulates work, writes a text artifact under `relaytor/agent/agent-workspace/`, and reports `completed` or `failed` to Core. This generated workspace is ignored by Git.

## Workflows

### Completed task

1. Select task text on a supported AI website and click **Send to Relaytor**.
2. The extension submits it to Core and displays `SENT`.
3. Run the reference agent with `--mode=completed`. It claims the oldest pending task and reports `WORKING`, then `COMPLETED`.
4. The extension displays the result. Copy it from the status chip or popup and paste it into the AI conversation yourself.

### Failed task

Submit a task and run the reference agent with `--mode=failed`. The agent reports `WORKING`, then `FAILED`; the extension displays the failure result. This mode is for demonstrating the failure path.

The extension never inserts a result into the AI chat automatically. Copying and pasting are user actions.

## Security model

- **Localhost-only Core:** the server binds to `127.0.0.1:5000`, not a network interface for remote access. This release is not designed to be exposed to the internet.
- **Bearer authentication:** every `/v1/*` endpoint requires the locally generated token in the `Authorization: Bearer <token>` header. `/health` is the unauthenticated liveness endpoint. Core compares bearer tokens using a timing-safe comparison.
- **Local token handling:** Core saves its token in `relaytor/server/config.json`; the extension stores its configured copy in Chrome local extension storage; the reference agent reads it from `RELAYTOR_TOKEN`. The config file, its backup, and the generated agent workspace are excluded by `.gitignore`.
- **Explicit data flow:** selected text is sent to Core on the same machine, then made available to the local agent. Relaytor does not provide cloud relay or synchronization.

Anyone with access to the bearer token can call protected local API endpoints. Treat it as a credential and do not share it.

## Task state model

Core keeps task data in memory and assigns each task a server-generated UUID. Its normal transitions are:

```text
sent ─────→ working ─────→ completed
  │             └────────→ failed
  └──────────────────────→ failed
```

Core accepts task text up to 50,000 characters and HTTP request bodies up to 256 KB. Tasks are removed after 30 minutes without an update and are lost when Core restarts. The extension also marks a task `STALE` after its local ten-minute age limit.

The extension reports `OFFLINE` when it cannot reach Core and stops polling. It reports `UNKNOWN` when Core is reachable but returns `404` for the task, for example after task state has been lost, expired, or acknowledged. These states are intentionally distinct.

## API overview

All `/v1/*` routes require bearer authentication. The agent protocol uses these endpoints:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Unauthenticated Core liveness check |
| `POST` | `/v1/task` | Submit a task as JSON, for example `{"text":"..."}` |
| `GET` | `/v1/task/:requestId` | Read task state and result |
| `POST` | `/v1/agent/claim` | Claim the next pending task in FIFO order |
| `POST` | `/v1/agent/status` | Report `working`, `completed`, or `failed` |
| `POST` | `/v1/task/:requestId/ack` | Acknowledge and remove a task |

Task submission returns a server-generated request ID and initial `sent` status. Agent status updates follow the state transitions above; completed results include a summary, and failed results include an error.

## Verification

The Phase 1 automated results are:

| Suite | Result |
| --- | --- |
| Unit | 9/9 passed |
| Integration | 21/21 passed |
| **Total** | **30/30 passed** |

Run the suites from the repository root:

```bash
node relaytor/tests/core.unit.test.js
node relaytor/tests/core.integration.test.js
```

The integration suite starts its own Core on port `5000`; stop any separately running Core before starting it.

Manual browser verification passed **9/9 executed tests**. **B6 was intentionally skipped.** B6 expected `UNKNOWN` after restarting Core while a task was being polled. In the verified implementation, loss of Core connectivity stops polling and reports `OFFLINE`; `UNKNOWN` is reported when Core is reachable and returns `404`. The extension was not changed to force B6 to pass. See [`tests/run-acceptance.md`](tests/run-acceptance.md) for the manual runbook.

## Known limitations and Phase 1 boundaries

- Task storage is in memory; tasks are not durable and do not synchronize across devices.
- The extension must be loaded manually in browser Developer Mode.
- The reference agent simulates work and writes a text file; it does not edit a real project.
- There are no native Cline, Cursor, Roo, Copilot, or other IDE integrations.
- There are no cloud relay services, user accounts, payments, subscriptions, analytics, multi-user deployments, or autonomous browser verification.
- Core is intended for localhost use only.

Phase 1 establishes and verifies the local control layer. These limitations are intentional boundaries, not features implied by the reference implementation.

## Repository structure

```text
Relaytor/
├── relaytor/
│   ├── server/
│   │   └── relaytor-core.js
│   ├── agent/
│   │   └── test-agent.js
│   ├── extension/
│   │   ├── manifest.json
│   │   ├── background.js
│   │   ├── content.js
│   │   ├── popup.html
│   │   └── popup.js
│   ├── tests/
│   │   ├── core.unit.test.js
│   │   ├── core.integration.test.js
│   │   └── run-acceptance.md
│   └── README.md
├── .gitignore
├── package.json
├── package-lock.json
├── relaytor-setup.js
└── index.js
```

## Release

- Phase 1 release: [`v1.0.0`](https://github.com/kiosk280-sketch/Relaytor/releases/tag/v1.0.0)
- Phase 1 commit: [`f54cb53`](https://github.com/kiosk280-sketch/Relaytor/commit/f54cb53)
- Repository: [kiosk280-sketch/Relaytor](https://github.com/kiosk280-sketch/Relaytor)
