#!/usr/bin/env node
// Canonical parser: omp session .jsonl -> structured turns for the review UI.
// Pure, dependency-free. Also exposes cost/compaction signals so the UI can
// show what a resume will re-prefill and offer a compacted (cheaper) path.
import { readFileSync } from "node:fs";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return "";
}

// image content blocks -> { t:'image', mime, hash } (omp blob store) or
// { t:'image', mime, data } (inline base64). Anything else is dropped.
const IMG_MIME = /^image\/(png|jpeg|webp|gif)$/;
function imagesOf(content) {
  const out = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || b.type !== "image" || typeof b.data !== "string") continue;
    const mime = String(b.mimeType || "image/png");
    if (!IMG_MIME.test(mime)) continue;
    const hm = /^blob:sha256:([0-9a-f]{64})$/.exec(b.data);
    if (hm) out.push({ t: "image", mime, hash: hm[1] });
    else if (b.data.length < 4_000_000 && /^[A-Za-z0-9+/=\s]+$/.test(b.data.slice(0, 200))) out.push({ t: "image", mime, data: b.data });
  }
  return out;
}

// Parse into { title, cwd, turns, tokens, compaction }.
//  turns[i] = { i, role, ts, model, blocks:[ {t:'text'|'thinking', text} | {t:'tool',name,intent,args} | {t:'result',toolName,isError,text} | {t:'image',mime,hash|data} ] }
//  (a toolResult's blocks[0] is always the result; images follow it)
//  tokens   = best-known context size (what a full resume re-prefills)
//  compaction = { summary, shortSummary } | null   (omp's own latest rollup)
export function parseSession(jsonl) {
  const lines = String(jsonl).split("\n").filter((l) => l.trim());
  let title = "session", cwd = "";
  let tokens = 0, promptTokens = 0, cost = 0;
  let compaction = null;
  const turns = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type === "session" || o.type === "title" || o.type === "title_change") && o.title) title = o.title; // last one wins
    if (o.type === "session" && o.cwd) cwd = String(o.cwd);
    if (o.type === "compaction") {
      compaction = { summary: o.summary || "", shortSummary: o.shortSummary || "", tokensBefore: o.tokensBefore, tokensAfter: o.tokensAfter };
    }
    if (o.type !== "message") continue;
    const m = o.message || {};
    const role = m.role;
    const ts = m.timestamp || o.timestamp || "";
    if (role === "assistant") {
      if (m.usage) {
        if (m.usage.totalTokens > tokens) tokens = m.usage.totalTokens;
        if (m.usage.cost && typeof m.usage.cost.total === "number") cost += m.usage.cost.total;
      }
      if (m.contextSnapshot && m.contextSnapshot.promptTokens) promptTokens = m.contextSnapshot.promptTokens; // last snapshot = current context
    }
    const blocks = [];
    if (role === "user") {
      blocks.push({ t: "text", text: textOf(m.content) }, ...imagesOf(m.content));
    } else if (role === "assistant") {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || !b.type) continue;
        if (b.type === "thinking") blocks.push({ t: "thinking", text: b.thinking || "" });
        else if (b.type === "text") blocks.push({ t: "text", text: b.text || "" });
        else if (b.type === "toolCall") blocks.push({ t: "tool", name: b.name || "", intent: b.intent || "", args: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments, null, 1) });
      }
    } else if (role === "toolResult") {
      blocks.push({ t: "result", toolName: m.toolName || "", isError: !!m.isError, text: textOf(m.content) }, ...imagesOf(m.content));
    } else continue;
    turns.push({ i: turns.length, role, ts, model: m.model || "", blocks });
  }
  return { title, cwd, turns, tokens, promptTokens: promptTokens || tokens, cost, compaction };
}

// Build a COMPACT resume prompt: omp's own latest rollup + a short tail + the
// human's comments. Used when the reviewer opts into cheap (lossy) resume.
export function compactPrompt(parsed, commentBlock) {
  const parts = [];
  if (parsed.compaction && (parsed.compaction.summary || parsed.compaction.shortSummary)) {
    parts.push("PRIOR SESSION SUMMARY (compacted):\n" + (parsed.compaction.summary || parsed.compaction.shortSummary));
  } else {
    // no rollup: take the first user ask + last few turns as a thin excerpt
    const firstUser = parsed.turns.find((t) => t.role === "user");
    if (firstUser) parts.push("ORIGINAL TASK:\n" + firstUser.blocks.map((b) => b.text).join("\n").slice(0, 2000));
  }
  const tail = parsed.turns.slice(-6).map((t) => {
    const body = t.blocks.map((b) => b.t === "tool" ? `→ ${b.name}` : (b.text || (b.t === "result" ? "[tool result]" : ""))).join("\n").slice(0, 600);
    return `[${t.role}] ${body}`;
  }).join("\n\n");
  parts.push("RECENT TURNS:\n" + tail);
  parts.push(commentBlock);
  return parts.join("\n\n---\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.argv[2];
  if (!f) { console.error("usage: node session-parse.mjs <session.jsonl>"); process.exit(2); }
  const p = parseSession(readFileSync(f, "utf8"));
  console.log(JSON.stringify({ title: p.title, turns: p.turns.length, tokens: p.tokens, hasCompaction: !!p.compaction }, null, 2));
}
