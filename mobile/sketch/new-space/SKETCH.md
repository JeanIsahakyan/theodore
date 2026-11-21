---
slug: new-space
medium: visual-2d
fidelity_reached: R0
contract_medium: ascii
lossy_axes: [glass depth, in-sheet push animation, haptics, exact type sizes]
---

# New space: where, model, effort, navigation

Accepted with `accept` (2026-11-21). The structure is locked; the felt
experience (glass, motion, haptics) is judged on a device.

## Home

```
[☰]        New space          [🔔][✎]

                  ⌘
              New space
   It runs on your computer; follow it from here.

╭──────────────────────────────────────────────╮
│ 🖥  mac-A ●                   up to Edit  ⌄ │  computer row
│ ──────────────────────────────────────────── │
│ 📁  theodore                              ⌄ │  project row
├──────────────────────────────────────────────┤
│ What should the agent work on?               │
│ (Opus 4.1 High ⌄)(Edit ⌄)                (↑) │
╰──────────────────────────────────────────────╯
```

Notes:
- Where it runs is two rows on the composer card, not a chip.
- Recent-project pills on the empty state are gone (they live in the project sheet).
- The model chip is smaller (30 high, 13 pt); the effort part is muted, no "·".
- Mode stays a chip next to the model.

| Case | Computer row | Project row |
| --- | --- | --- |
| one computer can take spaces | no ⌄, not tappable | normal |
| its only project | normal | no ⌄, not tappable |
| no computer can take a space | the card replaced by the empty state + Devices | — |

## Computer sheet

```
  Computer
  ● mac-A         3 projects · up to Edit ✓
  ● build-box     1 project · up to Run
  ○ Work Mac      Offline           (dim)
```

Tap: the computer picked, closed; the project becomes the last one used on
it, else its first; the agent pick is dropped and the mode capped.

## Project sheet

```
  Project · mac-A
  Recent
    theodore                              ✓
    web
  All
    cloud
    docs-site
```

Only the chosen computer's projects; tap: picked, closed. Search when more
than 6 projects.

## Model sheet

```
  Model
  ✦ Opus 4.1          Claude            ✓
  ✦ Sonnet 4.5        Claude
  ✦ GPT-5             Codex
  ✦ Gemini 2.5 Pro    Gemini
  ───
  All models                          12 ›
  Effort                  Default (High) ›
```

- Top 4: each agent's default model (agent order), then their next models
  round-robin until 4. A picked model outside them is shown 5th with ✓.
- A model tap applies it; the sheet closes when the model takes no effort.
- No effort row when the model takes none.

### All models ›

```
  ‹  All models
  🔍 Search models               (more than 8 models)
  CLAUDE
    Opus 4.1            Default           ✓
    Sonnet 4.5
  CODEX
    GPT-5               Default
  ───
    Reset to defaults
```

A tap applies the model and goes back to the main step (closes when no effort).

### Effort ›

```
  ‹  Effort
    Default (High)                        ✓
  ───
    Low
    Medium
    High
    Extra high
    Max
```

A tap applies it and goes back to the main step.

## Navigation

```
before   Home ──Start──▶ push /space/id   [‹]
after    Home ──Start──▶ /space/id, no slide   [☰] … [🔔][✎]
         drawer ───────▶ /space/id             [☰] … [🔔][✎]
```

- The space header is the main header's: menu, questions, new space.
- No iOS edge swipe back from a space; Android Back goes to Home.
- Devices and Settings stay pushed with Back.

## Queue while it runs (added before 0.1.27)

```
 ⟳ Edit src/app.ts                        newest step / log line
   Working · 42s
              ╭ and fix the tests ╮ Queued   queued bubble (mirrored host)
  Queued: runs after the current turn        note (host without mirror)
╭──────────────────────────────────────────────╮
│ Add to the queue…                            │  field always open
│ (Edit ⌄)(Opus 4.1 High ⌄)          (■) (↑)   │  Stop beside Send
╰──────────────────────────────────────────────╯
```

The host queues up to 5 messages from other devices (docs/fleet.md "Sends
queue"); past that, or an older computer: `fleet.busy`.
