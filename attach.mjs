#!/usr/bin/env node
// Attach an artifact (reasoning trace, output, log, html) to a task.
// Body is stored on disk under artifacts/<taskid>/; the event log keeps only
// a small pointer, so folding stays cheap no matter how large outputs get.
//
//   node attach.mjs <sess> <taskId> <kind> "<title>" --file path/to/output
//   some-agent | node attach.mjs <sess> <taskId> reasoning "step 3" --stdin
//   node attach.mjs <sess> <taskId> output "result" --text "inline body"
//
//   kind:   reasoning | output | log | html | note (free-form; badge only)
//   format: inferred from --file extension, or --format text|md|html|json|log
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { appendEvent, genId, artifactsDir } from "./lib.mjs";

const EXT = { text: "txt", md: "md", markdown: "md", html: "html", htm: "html", json: "json", log: "log", png: "png", webp: "webp", jpg: "jpg", jpeg: "jpg", gif: "gif", svg: "svg" };
const FMT_BY_EXT = { ".md": "md", ".markdown": "md", ".html": "html", ".htm": "html", ".json": "json", ".log": "log", ".txt": "text", ".png": "png", ".webp": "webp", ".jpg": "jpg", ".jpeg": "jpg", ".gif": "gif", ".svg": "svg" };
const IMG = new Set(["png", "webp", "jpg", "jpeg", "gif", "svg"]); // stored as raw bytes

export function attach(sess, taskId, kind, title, { body, bodyBuf, format } = {}) {
  if (!taskId) throw new Error("taskId required");
  const fmt = format || "text";
  const art = "a_" + genId().slice(2);
  const dir = join(artifactsDir(), taskId);
  mkdirSync(dir, { recursive: true });
  const file = join(taskId, `${art}.${EXT[fmt] || "txt"}`); // relative to artifactsDir()
  const data = bodyBuf != null ? bodyBuf : (body ?? ""); // Buffer (binary) or string
  writeFileSync(join(artifactsDir(), file), data);
  const ev = {
    op: "attach", id: taskId, art, kind: kind || "output",
    title: title || "", format: fmt, file, bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data),
  };
  appendEvent(sess, ev);
  return { art, file };
}

function main(argv) {
  const [sess, taskId, kind, title, ...rest] = argv;
  if (!sess || !taskId) {
    console.error('usage: node attach.mjs <sess> <taskId> <kind> "<title>" (--file <p> | --stdin | --text <s>) [--format text|md|html|json|log]');
    process.exit(2);
  }
  let format, body, bodyBuf;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--format") format = rest[++i];
    else if (rest[i] === "--file") {
      const p = rest[++i];
      const ex = extname(p).toLowerCase().slice(1);
      if (IMG.has(ex)) { bodyBuf = readFileSync(p); format = format || ex; }
      else { body = readFileSync(p, "utf8"); format = format || FMT_BY_EXT[extname(p).toLowerCase()] || "text"; }
    }
    else if (rest[i] === "--text") body = rest[++i];
    else if (rest[i] === "--stdin") body = readFileSync(0, "utf8");
  }
  if (body === undefined && bodyBuf === undefined) body = readFileSync(0, "utf8"); // default: read stdin
  const { art, file } = attach(sess, taskId, kind, title, { body, bodyBuf, format });
  console.log(art + "  " + file);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
