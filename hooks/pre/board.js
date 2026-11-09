// omp-board session hook (the orchestration layer).
//
// Lives in the repo at hooks/pre/board.js; install.sh puts a one-line shim at
// ~/.omp/agent/hooks/pre/board.js that re-exports it, so every omp session
// loads it and this file can find the rest of the repo next to itself.
// It makes each session board-aware without turning the board into a session log:
//   - the board is a curated BACKLOG of outstanding roadmap items (research /
//     exploration threads worth continuing), NOT one row per session,
//   - injects the live backlog into the model's context every turn, so the agent
//     sees outstanding work + your notes,
//   - a session owns a task ONLY when spawned to one (TODO_BOARD_TASK) or when it
//     explicitly `/board add`s a new item or `/board claim`s an existing one,
//   - exposes /board commands to add items, report status/notes/log, and attach
//     reasoning traces / outputs as artifacts.
// Nothing is auto-created or auto-closed: the backlog only changes deliberately.
//
// EVERY handler is wrapped so a board failure can never break a session.
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync, realpathSync } from "node:fs";

// where lib.mjs/attach.mjs live: TODO_BOARD_CODE, else two levels up from this
// file (hooks/pre/ -> repo root). Data dir is lib's own TODO_BOARD_DIR.
const BOARD_DIR = process.env.TODO_BOARD_CODE || resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..");
const AUTOCAP = process.env.TODO_BOARD_AUTOCAP === "1";         // auto-attach notable tool outputs
const CAP_MIN = Number(process.env.TODO_BOARD_AUTOCAP_MIN || 400); // min chars to auto-capture
const AUTOSESS = process.env.TODO_BOARD_AUTOSESSION === "1"; // opt-in ONLY: register+bind each session as its own task. Default OFF so the board stays a curated backlog, not a session registry (was the source of "session s_xxxx" noise).

let _lib = null;
async function lib() {
  if (!_lib) _lib = await import(pathToFileURL(join(BOARD_DIR, "lib.mjs")).href);
  return _lib;
}
async function attachFn() {
  return (await import(pathToFileURL(join(BOARD_DIR, "attach.mjs")).href)).attach;
}

// per-session state, keyed by session file (survives for the process lifetime)
const S = new Map();
function keyOf(ctx) {
  try { return ctx.sessionManager.getSessionFile() || "default"; } catch { return "default"; }
}
function sessId(file) {
  // Derive a STABLE id from the session's own UUID, not its filesystem path, so
  // a session omp moves/renames (e.g. -tmp -> permanent) keeps ONE task id
  // instead of orphaning the old card and spawning a duplicate.
  const b = basename(String(file));
  const um = b.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const key = um ? um[1].toLowerCase() : String(file);
  const h = createHash("sha1").update(key).digest("hex");
  return { sess: "s_" + h.slice(0, 6), taskId: "t_" + h.slice(0, 8) };
}
async function state(ctx) {
  const file = keyOf(ctx);
  let st = S.get(file);
  if (st) return st;
  const { sess } = sessId(file);
  // The board is a backlog of outstanding roadmap items, NOT a session registry.
  // A session owns a task ONLY if it was spawned to one (TODO_BOARD_TASK) or
  // explicitly claims/creates one via /board. It never auto-registers itself.
  const pinned = /^t_[a-z0-9]+$/.test(process.env.TODO_BOARD_TASK || "") ? process.env.TODO_BOARD_TASK : null;
  st = { file, sess, taskId: pinned, autoId: sessId(file).taskId };
  S.set(file, st);
  if (pinned) {
    try { const { appendEvent } = await lib(); appendEvent(sess, { op: "update", id: pinned, owner: sess, status: "doing" }); } catch {}
  } else {
    // a card already tracks this transcript (or this session's stable id):
    // bind to it, so terminal presence + board-review delivery reach this process
    try {
      const b = await boardSnapshot();
      const hit = b.tasks.find((t) => t.session === file) || b.tasks.find((t) => t.id === st.autoId);
      if (hit) { st.taskId = hit.id; st.boundPath = file; st.titled = !/^session s_/.test(hit.title || ""); }
    } catch {}
    if (!st.taskId && AUTOSESS) {
      // register this session as a task and bind its own transcript so it
      // shows on the board and is reviewable with zero manual steps.
      try {
        const { appendEvent } = await lib();
        appendEvent(sess, { op: "add", id: st.autoId, title: "session " + sess, status: "doing", priority: 1, session: file, archived: "" });
        st.taskId = st.autoId; st.boundPath = file; st.titled = false;
      } catch {}
    }
  }
  return st;
}

// readable card title: omp's own session title record (latest wins), else the
// first human prompt (skill-launched sessions often have no plain user text)
async function firstUserTitle(file) {
  try {
    const { readFileSync } = await import("node:fs");
    let ompTitle = null, prompt = null;
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === "title" && typeof o.title === "string" && o.title.trim()) { ompTitle = o.title.trim(); continue; }
      if (prompt || o.type !== "message" || !o.message || o.message.role !== "user") continue;
      const c = o.message.content;
      let tx = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "";
      tx = tx.replace(/\s+/g, " ").trim();
      if (tx) prompt = tx;
    }
    const t = ompTitle || prompt;
    return t ? t.slice(0, 80) : null;
  } catch {}
  return null;
}
// keep a terminal-bound card's transcript path fresh (omp moves to a new file
// on /resume, a fork, or a lock clash) and give a placeholder title a real one.
// Board-spawned runs (TODO_BOARD_TASK) are left to the server's own binding.
async function autoRefresh(ctx, st) {
  if (!st.taskId || process.env.TODO_BOARD_TASK) return;
  try {
    const { appendEvent } = await lib();
    const cur = keyOf(ctx);
    if (cur && cur !== "default" && cur !== st.boundPath) { appendEvent(st.sess, { op: "update", id: st.taskId, session: cur }); st.boundPath = cur; }
    if (!st.titled) { const ttl = await firstUserTitle(st.boundPath); if (ttl) { appendEvent(st.sess, { op: "update", id: st.taskId, title: ttl }); st.titled = true; } }
  } catch {}
}

async function boardSnapshot() {
  const { fold, readAllEvents } = await lib();
  return fold(readAllEvents());
}
function taskLine(t) {
  return `${t.status === "done" ? "[x]" : t.status === "doing" ? "[~]" : t.status === "blocked" ? "[!]" : "[ ]"} ${t.title} (p${t.priority}${t.owner ? " @" + t.owner : ""}) ${t.id}`;
}

export default function board(pi) {
  const log = (m) => { try { pi.logger.info(`[todo-board] ${m}`); } catch {} };

  // eagerly bind on session start
  pi.on("session_start", async (_e, ctx) => {
    try { const st = await state(ctx); log(st.taskId ? `session owns task ${st.taskId}` : "session board-aware (no task owned)"); startLink(ctx); } catch (e) { log("start: " + e.message); }
  });

  // ---- terminal link: presence heartbeat + board-review inbox ----
  // An interactive (tui) main session bound to a card heartbeats
  // <board>/live/<task>.json; the board then delivers reviews here, into THIS
  // terminal, as a user message (instead of `omp -p --resume`, which forks the
  // transcript while the terminal holds it open). Board-spawned runs
  // (TODO_BOARD_TASK) and subagents never link.
  let linkTimer = null, linkCtx = null, liveId = null;
  const liveFile = (root, id) => join(root, "live", id + ".json");
  const linkTick = async () => {
    const ctx = linkCtx; if (!ctx) return;
    const st = await state(ctx);
    const L = await lib(); const root = L.root();
    if (liveId && liveId !== st.taskId) { try { unlinkSync(liveFile(root, liveId)); } catch {} liveId = null; }
    if (!st.taskId) return;
    mkdirSync(join(root, "live"), { recursive: true });
    const tmp = liveFile(root, st.taskId) + "." + process.pid;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, file: keyOf(ctx), ts: Date.now() }));
    renameSync(tmp, liveFile(root, st.taskId));
    liveId = st.taskId;
    const box = join(root, "inbox", st.taskId);
    let names; try { names = readdirSync(box).filter((n) => n.endsWith(".json")).sort(); } catch { return; }
    for (const n of names) {
      const claimed = join(box, n + ".taken" + process.pid);
      try { renameSync(join(box, n), claimed); } catch { continue; } // another process won it
      let msg = null; try { msg = JSON.parse(readFileSync(claimed, "utf8")); } catch {}
      try { unlinkSync(claimed); } catch {}
      if (!msg || typeof msg.text !== "string" || !msg.text.trim()) continue;
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
      if (idle) await pi.sendUserMessage(msg.text); else await pi.sendUserMessage(msg.text, { deliverAs: "followUp" });
      L.appendEvent(st.sess, { op: "log", id: st.taskId, text: `📥 ${msg.label || "board message"} delivered into the terminal session (pid ${process.pid})${idle ? "" : ", queued behind the current turn"}` });
    }
  };
  const startLink = (ctx) => {
    if (!ctx || ctx.mode !== "tui" || (ctx.agent && ctx.agent.kind === "sub") || process.env.TODO_BOARD_TASK) return;
    linkCtx = ctx;
    if (linkTimer) return;
    try { linkTimer = ctx.setInterval(linkTick, 3000); linkTick().catch((e) => log("link: " + e.message)); } catch (e) { log("link: " + e.message); }
  };
  const stopLink = async () => {
    try { if (linkTimer && linkCtx) linkCtx.clearTimer(linkTimer); } catch {}
    linkTimer = null;
    try { if (liveId) unlinkSync(liveFile((await lib()).root(), liveId)); } catch {}
    liveId = null;
  };

  // inject the live backlog into context every turn
  pi.on("before_agent_start", async (_e, ctx) => {
    try {
      const st = await state(ctx);
      await autoRefresh(ctx, st);
      startLink(ctx);
      const b = await boardSnapshot();
      const open = b.tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
      const mine = st.taskId ? b.tasks.find((t) => t.id === st.taskId) : null;
      const lines = [];
      lines.push("📋 todo board — shared backlog of outstanding roadmap items.");
      if (mine) {
        lines.push(`YOUR TASK: ${taskLine(mine)}`);
        if (mine.notes) lines.push(`  human notes: ${mine.notes}`);
        if (mine.artifacts && mine.artifacts.length) lines.push(`  artifacts attached: ${mine.artifacts.length}`);
      }
      const rest = open.filter((t) => t.id !== st.taskId);
      if (rest.length) {
        lines.push(`OPEN ITEMS (${rest.length}):`);
        for (const t of rest.slice(0, 8)) lines.push("  " + taskLine(t));
      } else if (!mine) {
        lines.push("(backlog empty)");
      }
      lines.push(mine
        ? "Report with /board note|log|attach|done|block. Attach reasoning/outputs so they show on the task page."
        : "This is a backlog, not a session log — only record OUTSTANDING work. Surface a new roadmap item with /board add <title>, or pick one up with /board claim <id>.");
      return { message: { customType: "board", attribution: "todo-board", display: "📋 board synced", content: [{ type: "text", text: lines.join("\n") }] } };
    } catch (e) { log("inject: " + e.message); }
  });

  // opt-in: auto-attach notable tool outputs — only when this session owns a task
  pi.on("tool_result", async (event, ctx) => {
    if (!AUTOCAP || event.isError) return;
    try {
      const st = await state(ctx);
      if (!st.taskId) return;
      const text = (event.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
      if (!text || text.length < CAP_MIN) return;
      const attach = await attachFn();
      attach(st.sess, st.taskId, "output", `${event.toolName} output`, { body: text, format: "text" });
    } catch (e) { log("autocap: " + e.message); }
  });
  // No shutdown mutation of status: the backlog is a curated list of outstanding
  // items; sessions never auto-close or auto-drop tasks. Resolve items
  // deliberately (/board done|block, or from the browser).

  // "waiting on you" signal for the board's alerts: a tool approval prompt, an
  // `ask` question, or a finished turn. Main agent only (subagents never prompt
  // the operator). Written only on change, so a busy session stays quiet.
  const wait = async (ctx, kind, text) => {
    try {
      if (ctx && ctx.agent && ctx.agent.kind === "sub") return;
      const st = await state(ctx);
      if (!st.taskId) return;
      const key = kind ? kind + "\u0000" + text : "";
      if ((st.waitKey || "") === key) return;
      st.waitKey = key;
      const { appendEvent, nowTs } = await lib();
      appendEvent(st.sess, { op: "update", id: st.taskId, waiting: kind || "", waitText: kind ? String(text || "").slice(0, 300) : "", waitSince: kind ? nowTs() : "" });
    } catch (e) { log("wait: " + e.message); }
  };
  const askText = (input) => {
    const q = input && Array.isArray(input.questions) ? input.questions : [];
    return q.map((x) => x && x.question).filter(Boolean).join(" · ") || "the agent asked a question";
  };
  pi.on("tool_approval_requested", async (e, ctx) => { await wait(ctx, "approval", `approve ${e.toolName || "tool"}${e.reason ? ": " + e.reason : ""}`); });
  pi.on("tool_approval_resolved", async (_e, ctx) => { await wait(ctx, "", ""); });
  pi.on("tool_call", async (e, ctx) => { if (e && e.toolName === "ask") await wait(ctx, "question", askText(e.input)); });
  pi.on("tool_execution_end", async (e, ctx) => { if (e && e.toolName === "ask") await wait(ctx, "", ""); });
  pi.on("agent_start", async (_e, ctx) => { await wait(ctx, "", ""); });
  pi.on("agent_end", async (_e, ctx) => { await wait(ctx, "idle", "finished its turn — waiting for your next prompt"); });
  pi.on("session_shutdown", async (_e, ctx) => { await wait(ctx, "", ""); await stopLink(); });

  // /board <sub> [args] — report + attach from inside a session
  pi.registerCommand("board", {
    description: "todo board: list|add|claim|note|log|attach|figure|status|task|done|block",
    handler: async (args, ctx) => {
      const say = async (t) => { try { await pi.sendMessage({ role: "user", content: [{ type: "text", text: t }] }); } catch {} };
      try {
        const st = await state(ctx);
        const { appendEvent, fold, readAllEvents, genId } = await lib();
        const parts = String(args || "").trim().split(/\s+/);
        const sub = parts.shift();
        const rest = parts.join(" ");
        const board = () => fold(readAllEvents());
        const needTask = () => { if (!st.taskId) { say("board: you don't own a task yet — /board add <title> to record a new item, or /board claim <id> to pick one up"); return true; } return false; };

        // list — always available (default action too)
        if (!sub || sub === "list") {
          const open = board().tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
          return say("board (" + open.length + " open):\n" + (open.map(taskLine).join("\n") || "  (backlog empty)") + (st.taskId ? `\n(you = ${st.taskId})` : ""));
        }
        // add — record a new outstanding roadmap item and own it
        if (sub === "add") {
          const title = rest.trim();
          if (!title) return say("board: usage /board add <title>");
          const id = genId();
          appendEvent(st.sess, { op: "add", id, title, status: "todo", priority: 1, owner: st.sess });
          st.taskId = id;
          return say(`board: added ${id} — ${title}`);
        }
        // claim — take ownership of an existing item
        if (sub === "claim") {
          const id = rest.trim();
          if (!/^t_[a-z0-9]+$/.test(id)) return say("board: usage /board claim t_xxxxxxxx");
          if (!board().tasks.some((t) => t.id === id)) return say(`board: no such task ${id}`);
          st.taskId = id; appendEvent(st.sess, { op: "update", id, owner: st.sess, status: "doing" });
          return say(`board: claimed ${id}`);
        }
        // everything below mutates the session's own task
        if (needTask()) return;
        if (sub === "status" || ["todo", "doing", "blocked", "done"].includes(sub)) {
          const s = sub === "status" ? rest : sub;
          appendEvent(st.sess, { op: "update", id: st.taskId, status: s });
          return say(`board: status -> ${s}`);
        }
        if (sub === "done" || sub === "block") {
          appendEvent(st.sess, { op: "update", id: st.taskId, status: sub === "done" ? "done" : "blocked" });
          return say(`board: ${st.taskId} -> ${sub}`);
        }
        if (sub === "note") { appendEvent(st.sess, { op: "note", id: st.taskId, text: rest }); return say("board: note saved"); }
        if (sub === "log") { appendEvent(st.sess, { op: "log", id: st.taskId, text: rest }); return say("board: logged"); }
        if (sub === "task") { appendEvent(st.sess, { op: "update", id: st.taskId, title: rest }); return say(`board: title -> ${rest}`); }
        if (sub === "figure" || sub === "fig") {
          const sp = rest.indexOf(" ");
          const path = (sp < 0 ? rest : rest.slice(0, sp)).trim();
          const caption = sp < 0 ? "" : rest.slice(sp + 1).trim();
          if (!path) return say("board: usage /board figure <path.png> [caption]");
          const ex = (path.split(".").pop() || "").toLowerCase();
          if (!/^(png|webp|jpg|jpeg|gif|svg)$/.test(ex)) return say("board: /board figure needs an image (png/webp/jpg/gif/svg)");
          const attach = await attachFn();
          const { readFileSync } = await import("node:fs");
          const { art } = attach(st.sess, st.taskId, "figure", caption || basename(path), { bodyBuf: readFileSync(path), format: ex });
          return say(`board: figure ${art} attached — ${caption || basename(path)}`);
        }
        if (sub === "attach") {
          const [path, kind] = rest.split(/\s+/);
          if (!path) return say("board: usage /board attach <path> [kind]");
          const attach = await attachFn();
          const { readFileSync } = await import("node:fs");
          const ex = (path.split(".").pop() || "").toLowerCase();
          if (/^(png|webp|jpg|jpeg|gif|svg)$/.test(ex)) {
            const { art } = attach(st.sess, st.taskId, "figure", basename(path), { bodyBuf: readFileSync(path), format: ex });
            return say(`board: figure ${art} attached to ${st.taskId}`);
          }
          const body = readFileSync(path, "utf8");
          const fmt = /\.html?$/.test(path) ? "html" : /\.md$/.test(path) ? "md" : /\.json$/.test(path) ? "json" : "text";
          const { art } = attach(st.sess, st.taskId, kind || "output", basename(path), { body, format: fmt });
          return say(`board: attached ${art} to ${st.taskId}`);
        }
        return say(`board: unknown subcommand '${sub}' — try list|add|claim|note|log|attach|figure|status|task|done|block`);
      } catch (e) { return say("board error: " + e.message); }
    },
  });
}
