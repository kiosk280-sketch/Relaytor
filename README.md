# Relaytor

Relaytor is a local-first bridge between web-based AI conversations and a coding agent running on your computer.

Relaytor's Chrome extension sends selected task text from supported AI websites to Relaytor Core, which runs on localhost and passes tasks to a local coding agent. The agent returns its result through Core to the browser.

```text
Web AI
  ↓
Relaytor Core
  ↓
Local Coding Agent
  ↓
Relaytor Core
  ↓
Web AI
```

## Key highlights

- **Local-first:** tasks and the agent stay on your computer.
- **Localhost-only:** Core listens on loopback; it is not a cloud relay.
- **Zero-dependency Phase 1 Core:** built with Node.js built-in modules.
- **Chrome extension:** sends selected task text from supported AI websites.
- **Reference coding agent:** demonstrates the local agent workflow.
- **Tested implementation:** automated unit and integration suites pass.

## Testing

- Unit: 9/9 passed
- Integration: 21/21 passed
- **Automated total: 30/30 passed**

## Release

Phase 1 release tag: [`v1.0.0`](https://github.com/kiosk280-sketch/Relaytor/releases/tag/v1.0.0)

## Repository structure

```text
relaytor/
├── README.md
├── server/
├── extension/
├── agent/
└── tests/
```

## Installation

Start with the [Relaytor setup and usage guide](relaytor/README.md).

## Documentation

- [Relaytor README](relaytor/README.md)
- [Acceptance test runbook](relaytor/tests/run-acceptance.md)

## Current Status

- Phase 1: Complete
- Phase 2: Complete
- Phase 3: User Validation (current focus)
