// prompts.mjs — the prompt surface the board sends back into a session.
//
// The prompt builders used by runSession and the review/reply routes.

// Assemble the human's review comments into the instruction block the resume
// prompt sends.
export function commentBlock(comments) {
  return "The human reviewed your transcript and left feedback. Each item cites a turn and, when they highlighted a passage, the exact quote. Address every item:\n"
    + (Array.isArray(comments) ? comments : []).map((c) => {
      const q = c.quote ? ` re: "${String(c.quote).replace(/\s+/g, " ").trim().slice(0, 160)}"` : "";
      return `- [turn ${c.turn}${c.ref ? " · " + c.ref : ""}]${q} ${String(c.text || "").trim()}`;
    }).join("\n");
}

// Phase-1 render contract (guidance only — the board does not enforce it). The
// task page renders assistant text as Markdown via public/detail.js `md`
// (headings, bold/italic, inline+fenced code, links, blockquotes, nested lists,
// GFM tables) and folds every tool call into a collapsed reasoning panel. This
// block teaches a spawned agent to shape output for that surface. Tune freely.
export const RENDER_GUIDE =
  "\n\nHow your output is read: your transcript appears on a web board that renders your"
  + " assistant messages as Markdown and auto-collapses every tool call into a reasoning panel."
  + " Write for that reader:\n"
  + "- Lead with a one-line **bold verdict** — the result first, the detail after.\n"
  + "- Organize with `##` headings when they apply: Summary, Changes, Evidence, Risks, Next.\n"
  + "- **Bold** key terms and numbers; use `code` for identifiers, paths, and commands; fence multi-line code or output in triple backticks.\n"
  + "- Prefer bullet or numbered lists for enumerations and GFM tables (| col | col |) for structured comparisons.\n"
  + "- Do not narrate tool steps in prose — the board already shows them; keep only conclusions in your text.\n"
  + "- Attach a plot or screenshot with `/board figure <path.png> [caption]` and it renders inline at that point.\n"
  + "- Renders: headings, bold/italic, lists, tables, blockquotes, links, code, LaTeX math ($…$ inline, $$…$$ display), inline ```svg figures, and images/files at paths you mention. Does NOT render: raw HTML, mermaid, callouts — avoid them.";

// The default spawn prompt (fresh start vs. --continue resume): the original
// core instruction (byte-identical to runSession's) plus the Phase-1 render
// guide appended to every board-spawned run.
export function freshPrompt(task, resuming) {
  const notes = task.notes ? (resuming ? `Current notes: ${task.notes}\n` : `Notes: ${task.notes}\n`) : "";
  return (resuming
    ? `Resuming your board task ${task.id} ("${task.title}").\n` + notes + `Continue from where you left off; act on anything new since your last turn. Be concise.`
    : `You are an omp agent assigned to a shared board task.\nTask id: ${task.id}\nTitle: ${task.title}\n` + notes + `Do the work needed to complete this task. Be concise. Your reasoning and output are captured to the task automatically.`)
    + RENDER_GUIDE;
}
