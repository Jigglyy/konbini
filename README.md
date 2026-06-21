# Kanbini

[![CI](https://github.com/Jigglyy/kanbini/actions/workflows/ci.yml/badge.svg)](https://github.com/Jigglyy/kanbini/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **A kanban board that lives on your machine - and lets your AI move the cards.**
> Offline-first. Plain text on disk. No cloud, no accounts, no telemetry.

Kanbini is a Trello-style kanban app built for one person and their AI.
Your boards live in a local SQLite file and export to plain Markdown +
JSON, so you own your data outright. A built-in **local MCP server** lets
any AI that speaks MCP - Claude, ChatGPT, Cursor, or your own agent -
read and rearrange your board while you watch the cards move in real time.

The pitch is simple: your tasks shouldn't need an internet connection, a
login, or a monthly fee just to exist. Kanbini keeps your whole board in
a local file you fully own, runs as a fast native app, and - when you
want a hand - lets an AI pull up a chair and move the cards in real time
while you watch.

The name mashes **kanban** with **konbini**, the Japanese corner store
that never closes: a board that's yours, local, and always on.

## Why Kanbini

- **Offline by default.** No accounts, no network, no telemetry. The only
  things that ever leave your machine are the ones you explicitly turn on
  - link previews and one-way Obsidian export - both off by default.
- **You own your data.** Everything is a local SQLite file with
  first-class, lossless plain-text export (Markdown + JSON), verified
  byte-identical by a round-trip test.
- **AI-native.** A token-gated local MCP server exposes read/write tools;
  the AI's edits stream into the live UI as it works.
- **Free and open source** under the [MIT license](LICENSE).

## Features

- **Boards, lists, cards** with drag-and-drop (live cross-list reorder),
  labels, due dates, priorities, per-list colours, and swimlanes (group
  by priority).
- **Card depth** - WYSIWYG description (saved as Markdown), checklists,
  comments, local attachments (paste an image straight in), cover images,
  and a per-card activity log. Cards with a description show a small marker
  in the list.
- **Multi-select** - Ctrl/Cmd-click cards (or Shift-click for a range) to
  pick several at once, then complete, set priority, re-label, move, or
  delete them in bulk from a floating action bar (or a right-click menu) -
  and drag the whole group between lists.
- **Local MCP server** - a token-gated 127.0.0.1 control channel + stdio
  server (`@kanbini/mcp`) with read/write tools (get / create / update /
  move / delete / label / comment / checklist / search). Edits stream
  into the open UI live. See [`docs/MCP.md`](docs/MCP.md).
- **Scriptable HTTP API** - the same token-gated 127.0.0.1 control channel
  is also a plain local HTTP API (REST routes for reads + writes, plus a
  batch endpoint that lands as one undo step) for non-MCP tools, scripts,
  and automation. Loopback only. See [`docs/MCP.md`](docs/MCP.md).
- **Own your data** - lossless plain-text export/import (`kanbini.json` +
  `cards/*.md` + attachment files); Backup + Restore live in Settings.
- **Cross-board search** via a Ctrl/Cmd+F command palette.
- **Templates** for boards and lists.
- **Undo / redo** with full snapshot restore on delete.
- **Customizable keyboard shortcuts.**
- **Board backgrounds** (colour / gradient / image) and continuous zoom.
- **Trello import** - bring an exported Trello board JSON in as a new board.
- **Opt-in integrations** (off by default): link previews and one-way
  push to an Obsidian vault.

## Install

There's no published installer yet - run it from source:

```sh
pnpm install
pnpm --filter @kanbini/desktop dev
```

It opens on a seeded sample board. After a fresh clone or any Electron
version bump, run the native rebuild once:

```sh
pnpm --filter @kanbini/desktop rebuild:native
```

To build a real installer, see [`docs/PACKAGING.md`](docs/PACKAGING.md)
(Windows NSIS + portable `.exe`; macOS `.dmg`; and a Linux **AppImage**,
built from a Linux host or WSL2 - see [Building for
Linux](docs/PACKAGING.md#building-for-linux)). **Windows is the primary
tested target**; the macOS and Linux recipes build from the same Electron
source but haven't been smoke-tested yet.

## Wire up an AI

The MCP server speaks the standard Model Context Protocol, so **any
MCP-capable client** can drive your board while it's open. Claude Desktop
and Claude Code are what we test against, but ChatGPT desktop, Cursor, or
your own agent work the same way - one config shape covers them all. The
snippet + token live in the app under **Settings → AI integration**;
details in [`docs/MCP.md`](docs/MCP.md).

## Develop

```sh
pnpm verify   # typecheck + unit tests + launch smoke (~20 s)
pnpm e2e      # Playwright end-to-end suite against the real Electron app
```

Exercise the MCP surface end-to-end (desktop app must be running):

```sh
pnpm --filter @kanbini/mcp run build         # one-time / after MCP changes
pnpm --filter @kanbini/mcp run smoke         # read-tool check
pnpm --filter @kanbini/mcp run smoke:write   # create → update → comment → checklist → delete
```

Prove the export/import round-trip is lossless (no live app needed):

```sh
pnpm --filter @kanbini/desktop run test:roundtrip
```

## Layout

```
/apps
  /desktop      Electron main + hardened preload + control channel
  /renderer     React + Vite + Tailwind v4 + ShadCN
  /mcp          @kanbini/mcp - stdio MCP server
  /desktop-e2e  Playwright end-to-end suite
/packages
  /shared       zod schemas, channel names, id/order utils
  /db           Drizzle schema + migrations + data access
/docs           DESIGN.md, MCP.md, PACKAGING.md
```

- Design & architecture → [`docs/DESIGN.md`](docs/DESIGN.md)
- MCP integration → [`docs/MCP.md`](docs/MCP.md)
- Packaging → [`docs/PACKAGING.md`](docs/PACKAGING.md)

## Contributing

Issues and pull requests are welcome. `pnpm verify` should be green before
you push. New features in `@kanbini/shared`, `@kanbini/db`, or
`@kanbini/renderer` should land with tests in the same change; bug fixes
should come with a regression test.

## License

[MIT](LICENSE) © Jigglyy and Kanbini contributors.
