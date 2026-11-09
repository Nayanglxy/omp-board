#!/usr/bin/env node
// Append helper an omp session calls to write to the board.
//
//   node append.mjs <session> add    '{"title":"Wire poll loop","priority":2}'
//   node append.mjs <session> update '{"id":"t_a1b2","status":"doing"}'
//   node append.mjs <session> note   '{"id":"t_a1b2","text":"blocked on key"}'
//   node append.mjs <session> drop   '{"id":"t_a1b2"}'
//
// Prints the task id (generated for `add` when absent). A session only ever
// writes its OWN segment, so concurrent sessions never contend.
import { appendEvent, genId } from "./lib.mjs";

export function append(sess, op, fields = {}) {
  const id = fields.id || (op === "add" ? genId() : undefined);
  if (!id && op !== "drop") throw new Error(`op '${op}' requires an id`);
  const rec = appendEvent(sess, { op, ...fields, id: id || fields.id });
  return rec.id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , sess, op, json] = process.argv;
  if (!sess || !op) {
    console.error("usage: node append.mjs <session> <add|update|note|drop> '<json>'");
    process.exit(2);
  }
  let fields = {};
  if (json) {
    try { fields = JSON.parse(json); }
    catch (e) { console.error("bad json:", e.message); process.exit(2); }
  }
  console.log(append(sess, op, fields));
}
