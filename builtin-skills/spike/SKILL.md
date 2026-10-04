---
name: spike
description: Throwaway experiment before committing to a build — timebox it, answer one question, then delete the code. Use when an approach is unproven ("once deneyelim", "spike yap", "bu kutuphane ise yarar mi", "prototip cikar") and the answer changes the design. Do NOT use for work whose output must ship; that is a normal task with tests.
license: MIT
metadata:
  crewpane.origin: builtin
  crewpane.author: Hermes Agent (adapted from gsd-build/get-shit-done)
  crewpane.copyright: Copyright (c) 2025 Nous Research
  crewpane.sourceCatalog: spike@0.1.0
  crewpane.upstreamCommit: e818025
  crewpane.upstreamSha256: 1f80760c022f8ad2dcdcb7349b046f761a276d6afa228f4e02eded7b0e1320da
  crewpane.modified: yes
  crewpane.status: published
  crewpane.reviewedBy: ironhide
  crewpane.reviewedAt: 2026-08-18
  upstream.version: 1.0.0
  upstream.author: Hermes Agent (adapted from gsd-build/get-shit-done)
  upstream.platforms: [linux, macos, windows]
  upstream.tags: [spike, prototype, experiment, feasibility, throwaway, exploration, research, planning, mvp, proof-of-concept]
---

# Spike

Use this skill when the user wants to **feel out an idea** before committing to a real build — validating feasibility, comparing approaches, or surfacing unknowns that no amount of research will answer. Spikes are disposable by design. Throw them away once they've paid their debt.

Load this when the user says things like "let me try this", "I want to see if X works", "spike this out", "before I commit to Y", "quick prototype of Z", "is this even possible?", or "compare A vs B".

## When NOT to use this

- The answer is knowable from docs or reading code — just do research, don't build
- The work is production path — use the `plan` skill instead
- The idea is already validated — jump straight to implementation

## Where the spike lives in this workspace

There is no sibling `gsd-spike` skill here — this is the standalone version and it is the one you use.

Keep spike code out of the product tree. One directory per spike under a scratch path
(`/tmp/.../scratchpad/spikes/<NNN>-<slug>/` or a repo-ignored `spikes/` dir), never inside
`src/`, `electron/`, or `app/`. A spike that lands in the product tree stops being throwaway
and starts being unreviewed production code.

When the spike answers its question, the verdict goes into the task's result file
(`docs/agent-results/<TASK-ID>-<agent>.md`) — the code itself is deleted or left in scratch.
The verdict is the deliverable, not the prototype.

## Core method

Regardless of scale, every spike follows this loop:

```
decompose  →  research  →  build  →  verdict
   ↑__________________________________________↓
                  iterate on findings
```

### 1. Decompose

Break the user's idea into **2-5 independent feasibility questions**. Each question is one spike. Present them as a table with Given/When/Then framing:

| # | Spike | Validates (Given/When/Then) | Risk |
|---|-------|----------------------------|------|
| 001 | websocket-streaming | Given a WS connection, when LLM streams tokens, then client receives chunks < 100ms | High |
| 002a | pdf-parse-pdfjs | Given a multi-page PDF, when parsed with pdfjs, then structured text is extractable | Medium |
| 002b | pdf-parse-camelot | Given a multi-page PDF, when parsed with camelot, then structured text is extractable | Medium |

**Spike types:**
- **standard** — one approach answering one question
- **comparison** — same question, different approaches (shared number, letter suffix `a`/`b`/`c`)

**Good spike questions:** specific feasibility with observable output.
**Bad spike questions:** too broad, no observable output, or just "read the docs about X".

**Order by risk.** The spike most likely to kill the idea runs first. No point prototyping the easy parts if the hard part doesn't work.

**Skip decomposition** only if the user already knows exactly what they want to spike and says so. Then take their idea as a single spike.

### 2. Align (for multi-spike ideas)

Present the spike table. Ask: "Build all in this order, or adjust?" Let the user drop, reorder, or re-frame before you write any code.

### 3. Research (per spike, before building)

Spikes are not research-free — you research enough to pick the right approach, then you build. Per spike:

1. **Brief it.** 2-3 sentences: what this spike is, why it matters, key risk.
2. **Surface competing approaches** if there's real choice:

   | Approach | Tool/Library | Pros | Cons | Status |
   |----------|-------------|------|------|--------|
   | ... | ... | ... | ... | maintained / abandoned / beta |

3. **Pick one.** State why. If 2+ are credible, build quick variants within the spike.
4. **Skip research** for pure logic with no external dependencies.

Use the pane's own tools for the research step:

- `WebSearch("python websocket streaming libraries 2025")` — find candidates
- `WebFetch("https://websockets.readthedocs.io/...")` — read the actual docs
- Bash — `pip show websockets | grep Version` to check what is installed in the project's venv

For libraries without docs pages, clone and read their `README.md` / `examples/` with Read. Context7 MCP (if the user has it configured) is also a good source — `mcp_*_resolve-library-id` then `mcp_*_query-docs`.

### 4. Build

One directory per spike. Keep it standalone.

```
spikes/
├── 001-websocket-streaming/
│   ├── README.md
│   └── main.py
├── 002a-pdf-parse-pdfjs/
│   ├── README.md
│   └── parse.js
└── 002b-pdf-parse-camelot/
    ├── README.md
    └── parse.py
```

**Bias toward something the user can interact with.** Spikes fail when the only output is a log line that says "it works." The user wants to *feel* the spike working. Default choices, in order of preference:

1. A runnable CLI that takes input and prints observable output
2. A minimal HTML page that demonstrates the behavior
3. A small web server with one endpoint
4. A unit test that exercises the question with recognizable assertions

**Depth over speed.** Never declare "it works" after one happy-path run. Test edge cases. Follow surprising findings. The verdict is only trustworthy when the investigation was honest.

**Avoid** unless the spike specifically requires it: complex package management, build tools/bundlers, Docker, env files, config systems. Hardcode everything — it's a spike.

**Building one spike** — a typical tool sequence:

```
Bash:  mkdir -p spikes/001-websocket-streaming
Write: spikes/001-websocket-streaming/README.md   ("# 001 websocket-streaming …")
Write: spikes/001-websocket-streaming/main.py
Bash:  cd spikes/001-websocket-streaming && python main.py
# Observe output, iterate.
```

**Parallel comparison spikes (002a / 002b).** Do NOT spawn a subagent — in this house an
agent runs in its own visible pane, never hidden inside another agent. Two options:

- **Sequential (default).** Build 002a, record its verdict, then 002b. A spike is timeboxed;
  two timeboxes back to back are usually cheaper than the coordination they replace.
- **Two panes.** If both variants need real engineering, ask the lead to open a second pane
  with its own task file. Each pane writes its own verdict; whoever asked writes the
  head-to-head from the two result files.

### 5. Verdict

Each spike's `README.md` closes with:

```markdown
## Verdict: VALIDATED | PARTIAL | INVALIDATED

### What worked
- ...

### What didn't
- ...

### Surprises
- ...

### Recommendation for the real build
- ...
```

**VALIDATED** = the core question was answered yes, with evidence.
**PARTIAL** = it works under constraints X, Y, Z — document them.
**INVALIDATED** = doesn't work, for this reason. This is a successful spike.

## Comparison spikes

When two approaches answer the same question (002a / 002b), build them **back to back**, then do a head-to-head comparison at the end:

```markdown
## Head-to-head: pdfjs vs camelot

| Dimension | pdfjs (002a) | camelot (002b) |
|-----------|--------------|----------------|
| Extraction quality | 9/10 structured | 7/10 table-only |
| Setup complexity | npm install, 1 line | pip + ghostscript |
| Perf on 100-page PDF | 3s | 18s |
| Handles rotated text | no | yes |

**Winner:** pdfjs for our use case. Camelot if we need table-first extraction later.
```

## Frontier mode (picking what to spike next)

If spikes already exist and the user says "what should I spike next?", walk the existing directories and look for:

- **Integration risks** — two validated spikes that touch the same resource but were tested independently
- **Data handoffs** — spike A's output was assumed compatible with spike B's input; never proven
- **Gaps in the vision** — capabilities assumed but unproven
- **Alternative approaches** — different angles for PARTIAL or INVALIDATED spikes

Propose 2-4 candidates as Given/When/Then. Let the user pick.

## Output

- Create `spikes/` (or `.planning/spikes/` if the user is using GSD conventions) in the repo root
- One dir per spike: `NNN-descriptive-name/`
- `README.md` per spike captures question, approach, results, verdict
- Keep the code throwaway — a spike that takes 2 days to "clean up for production" was a bad spike

## Attribution

Adapted from the GSD (Get Shit Done) project's `/gsd-spike` workflow — MIT © 2025 Lex Christopherson ([gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done)). The full GSD system offers persistent spike state, MANIFEST tracking, and integration with a broader spec-driven development pipeline; install with `npx get-shit-done-cc --hermes --global`.
