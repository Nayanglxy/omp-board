# DESIGN.md — todo-board

Design system for this project. **Read this before touching any UI in `server.mjs`.**
It exists so every agent session produces consistent surfaces instead of generic slop.
When you add or change UI, obey the token layer and the structural rules below; do not
invent a second convention beside an existing one.

The whole UI is two inlined HTML templates inside `server.mjs`: `PAGE` (the board home)
and `DETAIL` (the per-task transcript/review page). No framework, no build step, no
dependencies — vanilla DOM + template strings. Keep it that way.

---

## Hard constraints (non-negotiable)

- **Zero dependencies. Node 18. No build step.** Everything ships as strings in `server.mjs`.
  Do not add React/Tailwind/bundlers. If you reach for a library, you are doing it wrong.
- **CSS custom properties only.** Components read `var(--…)`. Never hardcode a hex in a
  component rule. New color need? It already exists in the ramp below — use it. If it truly
  doesn't, add it to `:root` in **both** templates, then reference the var.
- **No backticks and no `${}` inside the `PAGE`/`DETAIL` `<script>` bodies.** Those scripts live
  inside a backtick-delimited template literal. The only allowed `${}` is the single
  intended `${JSON.stringify(STATUSES)}`. Build strings with `'…' + x + '…'` concatenation.
  If you need a literal backtick in client JS, use `var BT = String.fromCharCode(96)`.
- **Both templates carry their own copy of `:root` and shared CSS.** Changing a token or a
  shared component style means editing PAGE **and** DETAIL. They must not drift.
- **Escape all user/agent text** through `esc()` before inserting into innerHTML. Every title,
  note, quote, tool arg, transcript block is untrusted.

---

## 1. Token layer

Five stacked layers. Components only ever touch the top two (purpose + density). Change one
hex at the base and it propagates everywhere without touching a component rule. **The failure
mode to avoid is a preferences screen with forty toggles — consistency comes from removing
knobs, not policing them.**

### Base palette (Urban Twilight, dark) — `:root`

Source: Piktochart "Urban Twilight" slate ramp `#2F4F4F #708090 #A9A9A9 #D3D3D3 #F5F5F5`.
The four darker grounds (`--bg`…`--ui2`) are darkened steps of `#2F4F4F`; the rest are the palette as-is.

```
--bg  #080B0B   page ground (near-black)
--bg2 #101616   raised panel / card fill
--ui  #172121   control fill, chips, kbd
--ui2 #223131   hairline borders, dividers
--ui3 #2F4F4F   stronger border, hover border      (palette)
--tx  #D3D3D3   body text; also --accent           (palette)
--tx2 #A9A9A9   secondary text / labels            (palette)
--tx3 #708090   tertiary / metadata / muted        (palette)
--hi  #F5F5F5   headings, emphasized numbers       (palette)
```

### Accent ramp — color carries STATE and nothing else

Desaturated toward slate so state reads without breaking the gray ramp.

```
--re #C97B7B  red     danger / blocked / error / destructive
--ye #CFB46E  yellow  running / live / in-flight
--gr #8FB59A  green   done / success / send-commit action
--cy #7FB0B0  cyan    tool
--bl #8EA6C4  blue    links, focus ring, sessions accent, user role
--pu #A59CC4  purple  roadmap accent, assistant role
--mg #B98AA6  magenta interrupted, human-review / comments, selection-action button
```

**Rule: never color-code by project, owner, or priority.** The moment two color axes compete,
"needs you" stops being findable at a glance — which is the only thing the session rail exists
for. Priority is shown by the `pchip` text/border, not by tinting the whole card. If you add a
new signal, express it with shape/border/text, not a new fill color.

### Elevation ladder (surface levels)

Four levels, used consistently, **never more than two floating layers on screen at once**:

```
page      var(--bg)                     the ground
panel     var(--bg2) + 1px var(--ui2)   hero stat, card, notes block, help box
control   var(--ui)  + 1px var(--ui3)   selects, buttons, chips, kbd
float     var(--bg2) + shadow           dialog (#artdlg), help overlay (#kh), task overlay (#ov)
```

Radius scale: `7px` chips/controls · `8–9px` buttons/inputs · `10–14px` cards/panels/dialogs.
Shadows only on `float`. Panels and controls are flat with a hairline border.

### Density layer (the customizability lever — currently one setting)

Density is meant to be **one global control**, not a per-component prop. The intended model:
a single `data-density="comfortable|compact"` attribute on `<body>` remaps a small set of
vars — control height, padding step, type scale, radius — together. Components read those
density vars; flipping the attribute restyles the whole app with zero component edits.
This is the correct answer to "I want lots of customizability": expose density (and, later,
an alternate base ramp for a light theme) as remaps at the token layer, not as a settings
panel. **If you implement it, do it as a token remap; do not scatter `if(compact)` through
components.**

---

## 2. Typography

- Base: `ui-sans-serif, system-ui` at `14.5px/1.55`, `tnum` on (tabular numerals everywhere).
- Mono: `ui-monospace, Menlo` for session ids, transcript `pre`, args, kbd, timestamps.
- Headings/section labels: uppercase, `letter-spacing .06–.07em`, `13px`, `--hi`, weight 650.
- Big metric numbers: `30px/700`, `--hi` (or the stat's accent), tabular.
- Never introduce a new font family or a heading style outside this scale.

---

## 3. Structural conventions

### Rows vs cards — deliberate, not incidental

- **Cards say "browse this."** Used for **Current Sessions** (`.card` grid): each session gets
  room for status, id, artifact count, resume/open, expandable notes. Fine at 4–8 sessions.
- **Rows say "scan this."** Used for **Roadmap** (`.ritem` timeline) and **Done** (`.drow`).
  Dense, one line of intent, action buttons inline.
- If the session count grows past what a card grid can scan at a glance, the migration is
  cards → dense rows (dot + one line of state), **not** more color or more chrome.

### Session rail state model

A session shows exactly one state via one accent: **running** (`--ye`, spinner + glow),
**interrupted** (`--or`, `⏸` badge + border), **idle/normal** (no accent), **done/dropped**
(dimmed, `.dn`). That is the whole vocabulary. Do not add a fifth colored state.

### Provenance stays attached

Roadmap items and captured artifacts point back to the session/turn that produced them
(`origin_session`, `session`, artifact `sess`). Keep that link visible. Do not build an orphan
backlog detached from where the work surfaced. When you render an agent-derived item, its
origin should be recoverable from the DOM (`data-id`, the `sub` line, the log).

### Comment anchoring

- The transcript is an **append-only immutable log**: turn *N* never regenerates, so anchoring
  a comment to the turn index (`data-i`) is stable. Do not over-engineer this.
- Regenerating markdown (roadmap/plan bodies) is the opposite case — if you ever let comments
  survive a regenerated section, the agent must emit **stable block IDs** (HTML-comment
  sentinels) into the markdown; do not try to reattach by line number or text match afterward.

### Batch-review model (DETAIL)

Comments accumulate client-side in the `comments` Map (whole-turn notes keyed `w<i>`, quoted
selections keyed `q<n>`). Nothing sends until the user commits the whole batch via the review
bar (`#bar`). The bar states the **count** prominently and is the single commitment point.
Keep it that way: no per-comment auto-send, no silent submission.

---

## 4. Component catalog (what already exists — reuse, don't reinvent)

| Component | Selector | Notes |
|---|---|---|
| Hero metric | `.hero .stat` | big tabular number + uppercase label + 3px accent bar |
| Session card | `.card` (`.running`/`.intr`/`.dn`) | status select, spinner/badge, pchip, resume/open, `.exp` details |
| Roadmap row | `.ritem` | pchip + title + `.ractions` (start/open/notes/status/drop) |
| Done row | `.drow` | status pill + strikethrough title + open + delete |
| Status select | `select.st.st-<status>` | the one editable status control; colors per status |
| Priority chip | `.pchip.p0..p3` | p0=red p1=orange, text/border only |
| Badge | `.badge`, `.ibadge` | interrupted/running markers |
| Review bar | `#bar` | fixed bottom, count `#barn`, compact toggle, `#send` (green commit) |
| Selection button | `#selbtn` | floating "comment" on text selection (orange) |
| Overlays / float | `#ov`, `#artdlg`, `#kh` | task iframe, captured responses, keyboard help |
| kbd hint | `.kbd`, `kbd`, `.khint` | keyboard affordances |

Buttons: `.b` (neutral control), `.send` (green commit), `.icon` (bare glyph). Destructive
actions use `--re` on hover, never as default fill.

---

## 5. Keyboard model

Every primary action has a key. Mouse-only review does not scale to several sessions.
A `? keys` affordance in each header and a `#kh` help overlay (toggle `?`) document the set.

**Board (`PAGE`)** — cursor is a task id (`kid`), ring = `.kfoc`:
`j`/`k` or `↓`/`↑` move · `o`/`Enter` open · `r` run/resume · `?` help · `Esc` close overlay/help.

**Review (`DETAIL`)** — cursor is a turn index (`kidx`), ring = `.kfoc`:
`j`/`k` or `↓`/`↑` move turn · `g`/`G` first/last · `c` comment on focused turn ·
`⌘↵`/`Ctrl↵` send batch (works from inside a textarea) · `Esc` blur field / clear focus · `?` help.

**Rules when adding keys:** ignore nav keys while typing in `input/textarea/select/contenteditable`
(only `Esc` to blur, and `⌘↵` to commit, are allowed through); re-apply the focus ring after any
re-render (`applyKfoc()` is called at the end of `paint()`/`renderTranscript()` because both rebuild
innerHTML on poll); never bind a plain letter that shadows normal typing outside a guarded field.

---

## 6. Verification norms (headless box — no browser)

There is no Chromium here. Prove UI work without eyeballing:

- `node --check server.mjs` for the module.
- Extract the client `<script>` from served HTML (`fetch` the page, regex the script, write a
  temp `.js`, `node --check` it). This catches client-JS syntax errors the module check misses.
- Curl/`fetch` the endpoints and assert on the returned HTML/JSON (markup present, escaping
  applied, classes wired).
- Logic with real behavior (idle cap, fold, markdown) → an isolated integration test against a
  temp `TODO_BOARD_DIR` and a fake `OMP_BIN`, asserting observable state. Throwaway; delete after.
- The guardrail blocks `curl … | node` (remote-exec pattern). Use `node -e` with global `fetch`
  and write to a temp file instead of piping.

State visual verification could not be performed and say why; never claim a look you didn't see.

---

## 7. Service / ops

Managed by the systemd user unit `omp-board.service` (`./install.sh --systemd`). Restart after edits:

```
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
systemctl --user restart omp-board
```

Binds `127.0.0.1:8787` only (loopback; host/origin guarded in the request handler). Env knobs:
`TODO_BOARD_PORT`, `TODO_BOARD_DIR`, `OMP_BIN`, `TODO_BOARD_MAX_SPAWN` (3), `TODO_BOARD_IDLE_MIN` (30).
