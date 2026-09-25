# Relaytor Phase 1 — Manual Test Runbook

Automated coverage: unit (U1–U9) and integration (I1–I11) run with Node.
Browser tests B1–B10 and acceptance tests A1–A2 are manual by design
(Phase 1 excludes autonomous browser verification).

## Prerequisites
- Node 18+
- Chrome/Chromium/Edge with Developer mode enabled

## Setup
1. `node server/relaytor-core.js` — copy the token from the console.
2. `chrome://extensions` → Load unpacked → `relaytor/extension`.
3. Popup → paste token → Save.

## Browser tests B1–B10 (record screenshot / console state per test)

- **B1** Visit a supported AI site → button visible, no console errors.
- **B2** Select task text → click Send → chip `SENT` + requestId.
- **B3** Task claimed by agent → chip `WORKING`.
- **B4** Delete token in popup, select text, Send → explicit error, nothing sent.
- **B5** Kill core while polling → chip `CORE OFFLINE`, polling stops (no further requests in core log).
- **B6** Restart core while polling → chip `UNKNOWN`, polling stops.
- **B7** Task WORKING → reload extension → polling resumes, terminal state still reached.
- **B8** Task in flight → refresh tab → popup retains task; chip returns on next update.
- **B9** Completed task → click chip / popup Copy → clipboard has formatted result; **no text appears in chat input**.
- **B10** Failed task → click copy → clipboard has error text.

## Acceptance tests

**A1 (completed):** web AI generates task → Send → core receives, UUID assigned →
`RELAYTOR_TOKEN=<token> node agent/test-agent.js --mode=completed` → agent reports WORKING (UI shows WORKING) →
agent writes file in `agent-workspace/` → reports COMPLETED (UI shows COMPLETED) →
click badge → result copied → paste into web AI.
Evidence: screen recording + created file + core log.

**A2 (failed):** same, `--mode=failed` → UI shows FAILED → click copies error → paste.
Evidence: screen recording + core log.

A test is PASS only with the evidence recorded next to it.
