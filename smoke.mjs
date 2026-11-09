#!/usr/bin/env node
// Concurrency smoke test: prove N sessions appending at once neither lose
// independent writes nor corrupt the log, and that the fold is deterministic
// last-writer-wins.
//
//   node smoke.mjs                 run the test
//   node smoke.mjs worker <k> <dir> <n>   (internal child)
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const WORKERS = 4;
const UPDATES = 60; // per worker, to t_shared

// ---- child: hammer the board from one session ----
if (process.argv[2] === "worker") {
  const k = Number(process.argv[3]);
  process.env.TODO_BOARD_DIR = process.argv[4];
  const n = Number(process.argv[5]);
  const { append } = await import("./append.mjs");
  const mine = append(`w${k}`, "add", { title: `task from w${k}`, priority: k % 4 });
  for (let i = 0; i < n; i++) {
    append(`w${k}`, "update", { id: "t_shared", priority: k }); // contended field
    if (i % 7 === 0) append(`w${k}`, "note", { id: mine, text: `w${k} tick ${i}` });
  }
  append(`w${k}`, "update", { id: mine, status: "done" });
  process.exit(0);
}

// ---- orchestrator ----
const dir = mkdtempSync(join(tmpdir(), "board-smoke-"));
process.env.TODO_BOARD_DIR = dir;
const lib = await import("./lib.mjs");

// seed the shared task once (single creator), then unleash the workers.
lib.appendEvent("seed", { op: "add", id: "t_shared", title: "shared", priority: 0 });

const kids = [];
for (let k = 0; k < WORKERS; k++) {
  kids.push(new Promise((res) => {
    const c = spawn(process.execPath, [SELF, "worker", String(k), dir, String(UPDATES)], { stdio: "inherit" });
    c.on("exit", (code) => res(code));
  }));
}
const codes = await Promise.all(kids);

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };

ok("all workers exited 0", codes.every((c) => c === 0), `codes=${codes}`);

// every raw event line must parse (no interleave corruption across writers)
let totalLines = 0, badLines = 0;
for (const f of readdirSync(lib.eventsDir())) {
  for (const line of readFileSync(join(lib.eventsDir(), f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    totalLines++;
    try { JSON.parse(line); } catch { badLines++; }
  }
}
ok("no torn/corrupt event lines", badLines === 0, `lines=${totalLines} bad=${badLines}`);

// expected line count: seed(1) + per worker [add 1 + updates + notes ceil(n/7) + final 1]
const notesPerWorker = Math.ceil(UPDATES / 7);
const expected = 1 + WORKERS * (1 + UPDATES + notesPerWorker + 1);
ok("no lost appends (count)", totalLines === expected, `got=${totalLines} want=${expected}`);

const board = lib.fold(lib.readAllEvents());
const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));

// every worker's own task survived and reached its final independent state
let indep = true;
for (let k = 0; k < WORKERS; k++) {
  const t = board.tasks.find((t) => t.origin_session === `w${k}` && t.id !== "t_shared");
  if (!t || t.status !== "done") { indep = false; }
}
ok("independent writes preserved (each worker task = done)", indep, `tasks=${board.tasks.length}`);

// LWW: shared.priority == priority of the globally last-sorted update event
const evs = lib.readAllEvents().filter((e) => e.id === "t_shared" && e.priority !== undefined);
const lastWinner = evs[evs.length - 1];
ok("shared task follows last-writer-wins", byId.t_shared && byId.t_shared.priority === Number(lastWinner.priority),
  `board=${byId.t_shared && byId.t_shared.priority} winner=${lastWinner && lastWinner.priority}`);

// fold is deterministic: two rebuilds are byte-identical
const a = JSON.stringify(lib.fold(lib.readAllEvents()));
const b = JSON.stringify(lib.fold(lib.readAllEvents()));
ok("fold is deterministic", a === b);

// artifacts fold cleanly: attach an artifact and confirm it lands on its task
lib.appendEvent("w0", { op: "attach", id: byId.t_shared.id, art: "a_smoke", kind: "output", title: "t", format: "text", file: "x/a_smoke.txt", bytes: 3 });
const t2 = lib.fold(lib.readAllEvents()).tasks.find((t) => t.id === "t_shared");
ok("attach op folds onto the task", Array.isArray(t2.artifacts) && t2.artifacts.some((a) => a.art === "a_smoke"),
  `artifacts=${t2.artifacts.length}`);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
