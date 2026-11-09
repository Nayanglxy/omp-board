// Shared core for the todo board.
// Canonical state = fold(all events). There is no cache file — the server folds
// live on every request. Truth lives in events/<session>.log (append-only,
// ONE writer per file) plus artifact bodies under artifacts/<taskId>/.
import {
  readFileSync, appendFileSync, readdirSync, mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Paths are resolved lazily so tests (and workers) can point TODO_BOARD_DIR
// at a temp dir before any call. Never cache these at import time.
export function root() {
  return process.env.TODO_BOARD_DIR || dirname(fileURLToPath(import.meta.url));
}
export const eventsDir = () => join(root(), "events");
export const artifactsDir = () => join(root(), "artifacts");

export const FIELDS = ["title", "status", "priority", "owner", "notes", "order", "session", "interrupted", "archived", "opened", "rank", "waiting", "waitText", "waitSince"];
// event keys that are bookkeeping, not content: a rank-only update (drag
// reorder) must not count as activity, or reordering would block auto-archive.
const META_KEYS = new Set(["ts", "sess", "op", "id", "rank", "_file", "_line"]);
export const STATUSES = ["todo", "doing", "blocked", "done", "dropped"];

export const nowTs = () => new Date().toISOString();
export const genId = () => "t_" + randomBytes(4).toString("hex");

const ensureDirs = () => mkdirSync(eventsDir(), { recursive: true });
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Append one event to the CALLER's own segment. One writer per file => no lock.
export function appendEvent(sess, ev) {
  ensureDirs();
  const rec = { ts: ev.ts || nowTs(), sess: String(sess), ...ev };
  appendFileSync(join(eventsDir(), safeName(sess) + ".log"), JSON.stringify(rec) + "\n");
  return rec;
}

// Read every event from every segment, tagged with a deterministic order key.
export function readAllEvents() {
  ensureDirs();
  const files = readdirSync(eventsDir()).filter((f) => f.endsWith(".log")).sort();
  const out = [];
  for (const f of files) {
    const lines = readFileSync(join(eventsDir(), f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // tolerate a torn tail line
      ev._file = f; ev._line = i;
      out.push(ev);
    }
  }
  // Deterministic last-writer-wins order: ts, then file, then line.
  out.sort((a, b) => cmp(a.ts, b.ts) || cmp(a._file, b._file) || a._line - b._line);
  return out;
}

// Fold the full event history into board state. Pure + deterministic.
export function fold(events) {
  const map = new Map();
  let order = 0;
  let maxTs = "";
  for (const ev of events) {
    if (ev.ts > maxTs) maxTs = ev.ts;
    const op = ev.op;
    if (op === "add" || op === "update" || op === "note" || op === "log" || op === "attach") {
      if (!ev.id) continue;
      let t = map.get(ev.id);
      if (!t) {
        t = {
          id: ev.id, title: "", status: "todo", priority: 0,
          owner: ev.owner || ev.sess || "", origin_session: ev.sess || "",
          notes: "", session: "", interrupted: false, log: [], artifacts: [], created: ev.ts, order: order++, updated: ev.ts,
        };
        map.set(ev.id, t);
      }
      if (op === "note") {
        if (typeof ev.text === "string") t.notes = ev.text;
      } else if (op === "log") {
        if (typeof ev.text === "string") t.log.push({ ts: ev.ts, sess: ev.sess || "", text: ev.text });
      } else if (op === "attach") {
        const a = {
          art: ev.art, kind: ev.kind || "output", title: ev.title || "",
          format: ev.format || "text", file: ev.file, bytes: ev.bytes || 0,
          ts: ev.ts, sess: ev.sess || "",
        };
        t.artifacts.push(a);
      } else {
        for (const k of FIELDS) if (ev[k] !== undefined) t[k] = ev[k];
        if (ev.priority !== undefined) t.priority = Number(ev.priority) || 0;
        if (ev.rank !== undefined) t.rank = ev.rank === "" || ev.rank === null ? null : Number(ev.rank);
      }
      if (op !== "update" || !Object.keys(ev).every((k) => META_KEYS.has(k))) t.updated = ev.ts;
    } else if (op === "drop" || op === "remove") {
      const t = map.get(ev.id);
      if (t) { t.status = "dropped"; t.updated = ev.ts; }
    }
    // unknown ops ignored
  }
  const tasks = [...map.values()].sort((a, b) => a.order - b.order);
  return { version: 1, updated: maxTs || nowTs(), tasks };
}
