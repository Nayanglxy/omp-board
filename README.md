# omp-board

A localhost browser board for your [omp](https://github.com/can1357/oh-my-pi) agent
sessions. Every omp session can show up as a card; open one to read the
transcript rendered like a chat (markdown, LaTeX math, highlighted code, images,
file previews), leave review comments on any turn or highlighted passage, and
send them back into the session.

- **Zero runtime dependencies.** Plain Node `>=18`, no `npm install`. KaTeX and
  highlight.js are vendored in `public/vendor/` (see `VERSIONS`), nothing is
  fetched from the network.
- **Event-sourced.** State is an append-only log in `events/`, one file per
  writer, folded on read. Concurrent sessions never clobber each other.
- **Localhost only.** The server binds `127.0.0.1`; reach it from a laptop over
  an SSH tunnel.

## Install

```sh
git clone <this repo> ~/omp-board && cd ~/omp-board
./install.sh              # hook every omp session into the board
./install.sh --systemd    # ...and run the board as a systemd --user service
node server.mjs           # or run it in the foreground instead
```

Open <http://127.0.0.1:8787>. On a remote box: `ssh -L 8787:localhost:8787 <box>`.

`install.sh` writes a one-line shim at `~/.omp/agent/hooks/pre/board.js` that
re-exports `hooks/pre/board.js` from the checkout, so `git pull` updates the
hook with no copy step. An existing `board.js` there is moved to
`~/.omp/agent/board.js.bak.<time>`. `./install.sh --uninstall` removes the shim
and the service.

To give **every new omp session its own card** automatically:

```sh
echo 'export TODO_BOARD_AUTOSESSION=1' >> ~/.bashrc
```

Without it, a session joins the board only via `/board add` or `/board claim`.
omp reads hooks at start-up, so already-running sessions need a restart.

## What you get

**Board** (`/`)
- **Current sessions** as cards, plus a roadmap backlog and a done/archived list.
- **Drag to reorder** by the ⠿ grip; the order persists.
- **Auto-archive:** cards idle for `TODO_BOARD_ARCHIVE_DAYS` (default 3) move to
  archived, and come back by themselves if the transcript is written again.
- **Waiting-on-you alerts:** a card is flagged when its session shows a tool
  approval prompt, asks a question (`ask` tool), or finishes its turn. You get an
  in-page toast plus an optional desktop notification (header toggles);
  clicking either opens the card.
- **In terminal** badge while the session is open in a terminal, and a
  copyable `omp --resume <id>` line on each card.

**Task page** (`/task/<id>`)
- Transcript as a conversation: your prompts, the agent's replies, tool calls
  folded into a collapsible reasoning panel.
- Markdown with **KaTeX math** (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`,
  `\begin{aligned}…`), highlighted code blocks with copy buttons, agent-drawn
  ```` ```svg ```` figures, pasted images, and **file chips** for local paths
  the agent mentions (click to preview the image, markdown or code).
- Comment on any turn or highlighted passage, then **send the batch** to the
  agent as one prompt.

## How review delivery works

- **Session open in a terminal** (card shows *in terminal*): the hook in that
  omp process heartbeats `live/<task>.json` every 3s. A review is dropped in
  `inbox/<task>/` and the hook submits it **into that terminal** as your next
  message (queued behind the current turn if the agent is busy). Board and
  terminal share one transcript.
- **No live terminal:** the server runs `omp -p --resume <transcript>` in the
  background and streams the reply into the page. If the transcript is locked
  by another omp process, omp writes a forked copy; the board follows that
  fork so the reply still lands in the chat. Each run's raw stdout is also kept
  as an artifact.
- Tip: to keep one thread, close a session's terminal before reviewing it from
  the board, or start (or resume) the session after installing so it links.

## In-session commands

The hook adds `/board` inside omp:

```
/board list | add <title> | claim <t_id> | task <new title> | note <text> | log <text>
/board attach <path> [kind] | figure <png> [caption]
/board status <todo|doing|blocked|done> | done | block
```

It also injects the open backlog into each turn's context (~600 tokens).

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `TODO_BOARD_PORT` | `8787` | server port |
| `TODO_BOARD_DIR` | the checkout | data dir (`events/`, `artifacts/`, `sessions/`, `live/`, `inbox/`) |
| `TODO_BOARD_CODE` | the checkout | where the hook finds `lib.mjs` (only if relocated) |
| `TODO_BOARD_AUTOSESSION` | off | `1` = each new omp session gets its own card |
| `TODO_BOARD_AUTOCAP` | off | `1` = auto-attach long tool outputs as artifacts |
| `TODO_BOARD_AUTOCAP_MIN` | `400` | min chars for auto-capture |
| `TODO_BOARD_ARCHIVE_DAYS` | `3` | idle days before auto-archive; `0` disables |
| `TODO_BOARD_IDLE_MIN` | `30` | kill a board-launched run after this many idle minutes |
| `TODO_BOARD_MAX_SPAWN` | `3` | max concurrent board-launched runs |
| `OMP_BIN` | `omp` on `PATH` | omp binary the server launches (`install.sh --systemd` pins it) |

## Security model

- Binds loopback only; there is no auth beyond that, so don't expose the port.
- HTML artifacts render in a scripts-off sandboxed iframe with a strict CSP.
- `/api/blob/<task>/<sha256>` serves only omp blobs that task's transcript
  references.
- `/api/file/<task>?path=` serves a local file only if its exact path appears in
  that task's transcript, it resolves under `$HOME` or `/tmp`, no path segment
  starts with a dot (so `~/.ssh`, `~/.aws` and similar are never served), its
  extension is an image or text type, and the request's `Host` header is
  loopback (defends against DNS rebinding).

## Layout

```
server.mjs          HTTP server: board, task pages, review/spawn routes, archive sweep
lib.mjs             paths, appendEvent, readAllEvents, fold
session-parse.mjs   omp .jsonl -> turns, tokens, images, cwd
prompts.mjs         prompt builders for board-launched runs
attach.mjs          attach an artifact to a task
append.mjs          CLI write helper (add|update|note|drop)
show.mjs            terminal view (node show.mjs [--watch])
smoke.mjs           concurrency + fold + artifact regression test
hooks/pre/board.js  the omp hook
public/             board + task page client; vendor/ = KaTeX, highlight.js
install.sh          hook shim + optional systemd unit
```

Runtime data (`events/`, `artifacts/`, `sessions/`, `live/`, `inbox/`) is
gitignored and created on first use.

`DESIGN.md` has the UI token rules; `PLAN.md` the design notes.

## Test

```sh
node smoke.mjs
```

## Limitations

- The board cannot answer an approval prompt for you; it tells you which
  session is waiting, and you answer in its terminal.
- Mermaid diagrams are shown as code, not drawn.
- A session killed without a clean exit can leave a stale "waiting" flag on its
  card until its next turn.

## License

MIT; see `LICENSE`. Vendored KaTeX (MIT) and highlight.js (BSD-3-Clause) keep
their own licenses in `public/vendor/`.
