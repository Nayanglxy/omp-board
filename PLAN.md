# todo-board — shared, persistent task board for concurrent omp sessions

A single always-on board that every omp session writes to, that you review/edit
in a browser, and that each session reads back. Event-sourced truth, one
localhost server as the surface, one omp hook that binds each session to a task.

## Why it's built this way

- **Event-sourced, one writer per file.** Truth is `events/<session>.log` —
  append-only, exactly one writer per file ⇒ no locks, no corruption, natural
  attribution. Canonical state = `fold(all events)`, a pure deterministic
  field-level last-writer-wins over `ts, file, line`. There is **no cache file**;
  the server folds live on every request (cheap: a few hundred lines).
- **We own the surface (no Lavish).** A zero-dep node HTTP server serves the
  board app, streams state, and accepts human edits straight onto the `human`
  segment. Dropped the Lavish dependency: no node-22 requirement, no external
  fetch, no base64-in-prompt encoding, no single-poller constraint.
- **The orchestration is a hook, not a daemon.** Coordination doesn't need an
  always-on brain — each session loads one omp hook that binds it to a board
  task, injects the board into its context each turn, and lets it report/attach.
  The shared log + per-session hook *is* the coordination.

## Topology

```
  omp session A ─┐  append own segment          ┌─ reads board each turn (hook)
  omp session B ─┤  events/<sess>.log           │  reports status/notes/artifacts
  omp session C ─┼─►  (append-only, 1 writer)  ─┤
  omp session D ─┘        │                      └─ /board commands
                          ▼
                 fold(readAllEvents())  ◄── server.mjs (systemd --user, :8787)
                          │                    ├─ GET /            board app
                          ▼                    ├─ GET /api/board   live state
                    your browser  ────────────►├─ POST /api/edit   human edits
                    (SSH -L tunnel)            ├─ GET /task/<id>   detail page
                                               └─ GET /artifact/…  reasoning/outputs
```

## Files

```
~/todo-board/
  lib.mjs        core: paths, appendEvent, readAllEvents, fold (+ artifacts), genId
  append.mjs     session write helper: add|update|note|drop
  attach.mjs     attach an artifact (reasoning/output/log/html) to a task
  server.mjs     the surface: localhost HTTP server + board app + task pages
  show.mjs       headless terminal view (node show.mjs [--watch])
  smoke.mjs      concurrency + fold + artifact regression test
  events/<sess>.log     one append-only segment per session (truth)
  artifacts/<taskId>/…  artifact bodies (pointers live in the event log)

~/.config/systemd/user/omp-board.service    persistence (install.sh --systemd)
~/.omp/agent/hooks/pre/board.js              shim -> hooks/pre/board.js (install.sh)
```

## Data model

Task (folded): `id, title, status, priority, owner, origin_session, notes,
artifacts[], created, order, updated`.

- `FIELDS   = title, status, priority, owner, notes, order`
- `STATUSES = todo, doing, blocked, done, dropped`
- Event ops: `add | update | note | drop | attach`. `attach` records
  `{art, kind, title, format, file, bytes}`; body is written under `artifacts/`.
- Status-not-deletion: `done`/`dropped` stay in the log (collapsed in the UI) so
  the board is an audit trail.

## Session write helpers

```
node append.mjs <sess> add    '{"title":"…","priority":2}'
node append.mjs <sess> update '{"id":"t_xxx","status":"doing"}'
node append.mjs <sess> note   '{"id":"t_xxx","text":"…"}'
node append.mjs <sess> drop   '{"id":"t_xxx"}'
some-output | node attach.mjs <sess> t_xxx reasoning "trace" --stdin
node attach.mjs <sess> t_xxx output "result" --file run.html
```

## The surface

```
node server.mjs                      # binds 127.0.0.1:8787 (TODO_BOARD_PORT overrides)
ssh -L 8787:localhost:8787 <box>     # from your laptop -> http://localhost:8787
```
Persisted as a systemd --user service via `./install.sh --systemd`:
`systemctl --user {status|restart|stop} omp-board`, `journalctl --user -u omp-board -f`.

Security: binds loopback only; reachability is the SSH tunnel. HTML artifacts
render in a scripts-OFF sandboxed iframe (+ CSP, nosniff); artifact routes are
id-validated (no path traversal).

## Orchestration — the session-binding hook

`hooks/pre/board.js` (loaded through the `~/.omp/agent/hooks/pre/board.js` shim) loads into every omp session and:

- **binds** the session to one board task (deterministic id from the session
  file, so a resumed session maps back — no duplicates);
- **injects** the live board into the model's context each turn
  (`before_agent_start`) — the agent sees its task, your notes, other open work;
- **exposes** `/board status|note|task|claim|attach|done|block|list` so the agent
  (or you) report progress and attach reasoning traces / outputs;
- **auto-captures** notable tool outputs as artifacts when `TODO_BOARD_AUTOCAP=1`
  (min size `TODO_BOARD_AUTOCAP_MIN`, default 400 chars);
- **never closes out** tasks on shutdown: the backlog changes only deliberately
  (`/board done|block`, or from the browser); idle session cards auto-archive.

Env: `TODO_BOARD_AUTOSESSION=1` gives each new session its own card;
`TODO_BOARD_AUTOCAP=1` enables output capture; `TODO_BOARD_CODE` points at the
code dir if relocated; `TODO_BOARD_DIR` relocates the data dir.

Every handler is wrapped so a board failure can never break a session.

## Optional next tier — central spawner

A non-LLM orchestrator (or a dedicated session) that reads the board and spawns
`omp -p` workers per task, capturing their stdout/reasoning into artifacts.
`omp -p` resolves credentials through omp's own AuthStorage — the board never
sees a key. Not built yet; the hook covers the attached-agent case without it.

## Planned — conversation-first transcript rendering (view-only, not built)

Problem: `renderTranscript` maps one card per JSONL message, so an agent's
`thinking`, each `tool` call, and every `toolResult` render as peer-level cards
interleaved with the agent's actual reply — the human's conversation is shredded
by machinery.

Fix (presentational only; `session-parse.mjs` stays faithful to messages):
- **Two layers.** A conversation *spine* (user + agent user-facing text, chat-like)
  and a *work layer* (thinking + tool call/result) collapsed into one muted strip
  inside each agent bubble, expandable, subordinate. Nothing removed.
- **Grouping.** New client-side `groupExchanges(turns)`: new exchange per `user`
  message; assistant `thinking`/`tool` blocks + trailing `toolResult` turns become
  work items; trailing agent text after the last tool call = the spine reply,
  interim text = work narration (the one heuristic; reversible via raw toggle).
- **Anchors preserved.** Every fragment keeps its original `data-i`; `+ note`,
  passage-select comments, and per-work-item notes all still resolve
  (`w<i>` / `turn===i` unchanged). Figures move under the agent bubble.
- **Escape hatch.** Keep `turnHtml` as a "raw turns" toggle; extend `t` to
  expand/collapse all work strips. Rail regrouped one tick per exchange.
- **Scope.** `server.mjs` DETAIL template only (render fns + CSS). No API change.
- **Verify.** served-HTML byte checks + extracted-client-JS `node --check`, plus
  `.jsonl` fixtures for: no-tool, multi-tool, error result, interleaved narration
  — asserting correct grouping and that every original `data-i` survives.
- **Kicker.** Ship behind the raw toggle; keep whichever rendering reads
  better.
