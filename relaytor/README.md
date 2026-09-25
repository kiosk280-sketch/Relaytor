# Relaytor — Phase 1

Local control layer connecting web-based AI conversations with a local coding agent.

WEB AI → RELAYTOR → LOCAL CODING AGENT → RELAYTOR → WEB AI

## Layout

```
relaytor/
├── server/relaytor-core.js      Core: localhost HTTP bridge (127.0.0.1:5000), zero dependencies
├── agent/test-agent.js          Reference agent-protocol implementation (NOT an IDE integration)
├── extension/                   Chrome MV3 extension
├── tests/
│   ├── core.unit.test.js        U1–U9   (node --test tests/core.unit.test.js)
│   ├── core.integration.test.js I1–I11  (node tests/core.integration.test.js)
│   └── run-acceptance.md        Manual browser + acceptance runbook (B1–B10, A1–A2)
└── README.md
```

## Run

1. Core: `node server/relaytor-core.js` — token printed to console and saved to
   `server/config.json`.
2. Extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
   Popup → paste token → Save.
3. Agent: `RELAYTOR_TOKEN=<token> node agent/test-agent.js --mode=completed`
   (or `--mode=failed`).

## Tests

- Unit: `node --test tests/core.unit.test.js`
- Integration (server must not already be running): `node tests/core.integration.test.js`
- Browser + acceptance: follow `tests/run-acceptance.md` manually.

## Phase 1 boundaries

No cloud relay, accounts, payments, analytics, autonomous verification, or native
Cline/Cursor/Roo/Copilot integration. The agent contract is plain HTTP:
claim → working → completed/failed. See the approved plan for the full contract.
