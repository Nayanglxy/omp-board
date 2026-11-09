#!/usr/bin/env node
// Render an omp session .jsonl into STATIC, script-free HTML.
//
//   node session-render.mjs <session.jsonl> > out.html
//   node session-render.mjs <session.jsonl> --title "..." > out.html
//
// Why not `omp --export`? That produces a JS-hydrated app (session embedded as
// a base64 blob, rendered client-side). The board shows artifacts in a
// scripts-OFF sandboxed iframe, where such an app renders blank. This emits
// plain HTML — headings, text, thinking, tool calls/results — that renders as-is
// with no JavaScript, so it is both safe and visible in that sandbox.
import { readFileSync } from "node:fs";

const CAP = 12000; // max chars per block body before truncation

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cap(s) {
  s = String(s == null ? "" : s);
  if (s.length <= CAP) return esc(s);
  return esc(s.slice(0, CAP)) + `\n\n<span class="trunc">… truncated ${s.length - CAP} more chars</span>`;
}
function when(ts) { try { return new Date(ts).toLocaleString(); } catch { return ts || ""; } }
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return "";
}

export function renderSession(jsonl, opts = {}) {
  const lines = String(jsonl).split("\n").filter((l) => l.trim());
  let title = opts.title || "session";
  const blocks = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session" && o.title) title = opts.title || o.title;
    if (o.type === "title" && o.title) title = opts.title || o.title;
    if (o.type !== "message") continue;
    const m = o.message || {};
    const role = m.role;
    const ts = when(m.timestamp || o.timestamp);
    if (role === "user") {
      blocks.push(`<section class="turn user"><div class="rh"><span class="role user">user</span><span class="ts">${esc(ts)}</span></div><pre class="body">${cap(textOf(m.content))}</pre></section>`);
    } else if (role === "assistant") {
      const inner = [];
      const meta = [m.model, m.usage && m.usage.output_tokens != null ? `${m.usage.output_tokens} out tok` : null].filter(Boolean).join(" · ");
      inner.push(`<div class="rh"><span class="role asst">assistant</span><span class="ts">${esc(ts)}${meta ? " · " + esc(meta) : ""}</span></div>`);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || !b.type) continue;
        if (b.type === "thinking") {
          inner.push(`<div class="think"><div class="lbl">thinking</div><pre class="body">${cap(b.thinking)}</pre></div>`);
        } else if (b.type === "text") {
          inner.push(`<pre class="body">${cap(b.text)}</pre>`);
        } else if (b.type === "toolCall") {
          const args = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments, null, 1);
          inner.push(`<div class="tool"><div class="lbl">→ ${esc(b.name)}${b.intent ? ' <span class="intent">' + esc(b.intent) + "</span>" : ""}</div><pre class="args">${cap(args)}</pre></div>`);
        }
      }
      blocks.push(`<section class="turn asst">${inner.join("")}</section>`);
    } else if (role === "toolResult") {
      const err = o.message.isError ? " err" : "";
      blocks.push(`<section class="turn result"><div class="rh"><span class="role tool${err}">${o.message.isError ? "tool error" : "tool result"}</span><span class="ts">${esc(m.toolName || "")}</span></div><pre class="body">${cap(textOf(m.content))}</pre></section>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root{color-scheme:dark}
  body{background:#0e1116;color:#e6edf3;margin:0;font:13px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{position:sticky;top:0;background:#0e1116cc;backdrop-filter:blur(6px);border-bottom:1px solid #222;padding:10px 16px;font-weight:600}
  header .n{color:#8b949e;font-weight:400;font-size:12px;margin-left:8px}
  main{max-width:960px;margin:0 auto;padding:12px 16px 60px}
  .turn{border:1px solid #222;border-radius:10px;margin:10px 0;padding:8px 12px;background:#0d1117}
  .turn.user{border-color:#1f6feb55}.turn.asst{border-color:#30363d}.turn.result{border-color:#23863655;background:#0c1210}
  .rh{display:flex;gap:10px;align-items:center;margin-bottom:4px}
  .role{font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:1px 7px;border-radius:9px;border:1px solid #30363d}
  .role.user{color:#58a6ff;border-color:#1f6feb}.role.asst{color:#d2a8ff;border-color:#8957e5}.role.tool{color:#3fb950;border-color:#238636}.role.tool.err{color:#f85149;border-color:#da3633}
  .ts{color:#6e7681;font-size:11px}
  pre.body,pre.args{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9}
  .think{border-left:2px solid #8957e5;margin:6px 0;padding-left:10px}
  .think .lbl{color:#a371f7;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .think pre.body{color:#b9a6d8}
  .tool{border-left:2px solid #1f6feb;margin:6px 0;padding-left:10px}
  .tool .lbl{color:#58a6ff;font:12px ui-monospace,Menlo,monospace}
  .tool .intent{color:#6e7681}
  pre.args{color:#8b949e;font-size:11px;max-height:220px;overflow:auto}
  .trunc{color:#6e7681;font-style:italic}
</style></head><body>
<header>${esc(title)}<span class="n">${blocks.length} turns · rendered by todo-board</span></header>
<main>${blocks.join("\n") || '<p class="trunc">no renderable messages</p>'}</main>
</body></html>`;
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  const ti = argv.indexOf("--title");
  const title = ti >= 0 ? argv[ti + 1] : undefined;
  if (!file) { console.error("usage: node session-render.mjs <session.jsonl> [--title <t>]"); process.exit(2); }
  process.stdout.write(renderSession(readFileSync(file, "utf8"), { title }));
}
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
