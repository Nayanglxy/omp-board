#!/usr/bin/env node
// Terminal board view for headless boxes — no browser, no display needed.
//   node show.mjs           print the board once
//   node show.mjs --watch   redraw whenever any event segment changes
import { watch } from "node:fs";
import { fold, readAllEvents, eventsDir, STATUSES } from "./lib.mjs";

const C = { reset:"\x1b[0m", dim:"\x1b[2m", bold:"\x1b[1m",
  todo:"\x1b[37m", doing:"\x1b[36m", blocked:"\x1b[31m", done:"\x1b[32m", dropped:"\x1b[90m" };
const MARK = { todo:"[ ]", doing:"[~]", blocked:"[!]", done:"[x]", dropped:"[-]" };

function draw() {
  const board = fold(readAllEvents());
  const rank = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
  const tasks = [...board.tasks].sort((a, b) =>
    (rank[a.status] - rank[b.status]) || (b.priority - a.priority) || (a.order - b.order));
  const w = process.stdout.columns || 100;
  process.stdout.write("\x1b[2J\x1b[H"); // clear
  const counts = STATUSES.map((s) => `${s}:${tasks.filter((t) => t.status === s).length}`).join("  ");
  console.log(`${C.bold}TODO BOARD${C.reset}  ${C.dim}${board.tasks.length} tasks   ${counts}${C.reset}`);
  console.log(C.dim + "-".repeat(Math.min(w, 100)) + C.reset);
  if (!tasks.length) console.log(C.dim + "  (empty — append events to populate)" + C.reset);
  for (const t of tasks) {
    const col = C[t.status] || "";
    const strike = (t.status === "done" || t.status === "dropped");
    const title = strike ? `${C.dim}${t.title}${C.reset}` : `${col}${t.title}${C.reset}`;
    const meta = `${C.dim}p${t.priority} ${t.origin_session}${t.owner ? " @" + t.owner : ""} ${t.id}${C.reset}`;
    console.log(`${col}${MARK[t.status] || "[?]"}${C.reset} ${title}`);
    console.log(`      ${meta}`);
    if (t.notes) for (const ln of String(t.notes).split("\n")) console.log(`      ${C.dim}- ${ln}${C.reset}`);
  }
  console.log(C.dim + "-".repeat(Math.min(w, 100)) + C.reset);
  console.log(`${C.dim}updated ${new Date().toLocaleTimeString()}${process.argv.includes("--watch") ? "  (watching — Ctrl-C to stop)" : ""}${C.reset}`);
}

draw();
if (process.argv.includes("--watch")) {
  let t = null;
  watch(eventsDir(), () => { clearTimeout(t); t = setTimeout(draw, 80); });
}
