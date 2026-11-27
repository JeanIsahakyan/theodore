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
[☰]        New space             [✎]

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
after    Home ──Start──▶ /space/id, no slide   [☰] … [✎]
         drawer ───────▶ /space/id             [☰] … [✎]
         drawer "Waiting for you · N" ─▶ Home (its question cards)
```

- The space header is the main header's: menu, new space. No bell: a
  waiting question shows on its space row (● waiting), in the drawer's
  "Waiting for you · N" row (only while N > 0, top of the list), on Home's
  banner and in the space itself; its push opens the space.
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

## Where and Mode out of the composer (0.1.28)

Accepted (2026-11-21). The where-card rows and the Mode chip leave the
composer; the composer keeps one chip, the model's.

```
                  ⌘
              New space
   It runs on your computer; follow it from here.

        ( 📁 theodore ⌄ )  on  ( 🖥 mac-A ⌄ )      centered under the hint
            project chip   muted   computer chip

╭──────────────────────────────────────────────╮
│ What should the agent work on?               │
│ (Opus 4.1 High ⌄)                        (↑) │  only the model chip
╰──────────────────────────────────────────────╯

long names wrap, still centered:
        ( 📁 long-project ⌄ )
     on ( 🖥 Jean's MacBook Pro ⌄ )
```

- The chips are the model chip's compact pill on each platform (SwiftUI
  bordered capsule small / AssistChip / web pill) with an icon.
- Project chip: no ⌄, not tappable when the computer has one project.
- Computer chip: always tappable; its sheet holds Mode.

### Computer sheet ─▶ Mode

```
  Computer
    ● mac-A        3 projects · up to Edit  ✓
    ● build-box    1 project · up to Run
    ○ Work Mac     Offline              (dim)
  ───
  Mode                              Edit ›

  ‹ Mode
    Ask
    Plan
    Edit                                  ✓      up to the computer's cap
    Run
```

A computer: picked, closed (as before). A mode: set, back to the
computers; the sheet stays open.

### Space: the mode in the model sheet

```
[☰]   fix the login bug…             [✎]
      on mac-A · Running · Edit                  the header shows the mode

╭──────────────────────────────────────────────╮
│ Ask the agent to change something…           │
│ (Opus 4.1 High ⌄)                   (■) (↑)  │  no Mode chip
╰──────────────────────────────────────────────╯

  Model                       ‹ Mode
    Opus 4.1      Claude  ✓     Ask
    GPT-5         Codex         Plan
  ───                           Edit            ✓
    All models         12 ›     Run
    Effort   Default (High) ›
    Mode               Edit ›   (a space only)
```

- The picked mode lives in the compose store (`spaceModes`), since the iOS
  sheet is a route: sticky per space, reset when a turn runs in another
  mode; Revise sets Plan; `sendMode(picked, space.mode)` on send.
- Run picked while the space isn't in Run: the warning above the composer.

## Space: the activity strip, its sheet, a sub-space's screen

Accepted (2026-11-21). What a running space is doing sits above the
composer; the phone can open a sub-space.

```
 ... chat ...
 ⟳ 2 of 5 · Edit auth · 1 queued             1m 12s   line 1: the plan's active
                                                       step, else the newest live
                                                       step / log line; a timer
 ◌ 2 agents · 2 sub-spaces (1 waiting)            ⌃   line 2: tap ─▶ the sheet
╭──────────────────────────────────────────────╮
│ Add to the queue…                            │
│ (Opus 4.1 High ⌄)                   (■) (↑)  │
╰──────────────────────────────────────────────╯

  Activity                                 the sheet: iOS formSheet route,
    Plan · 2 of 5                          Android ModalBottomSheet, web modal
      ✓ Read the flow
      ⟳ Edit auth
      ○ Tests
    This turn
      ◌ Explore the auth flow    running · 32s
      ✓ Review the tests         done · 1m 4s
    Sub-spaces
      ? Fix the flaky test       waiting for an answer   ›  ─▶ its screen
      ⟳ Update the docs          running                 ›
      ✓ Split the crate          merged                  ›

[‹]      Fix the flaky test                  /sub-space/<space>/<child>, Back
         sub-space of Retry on 429 · on mac-A · Waiting for you
 ... its last messages (read_space, 50, every 3 s while in front) ...
 ⟳ Running: Edit tests/flaky.rs              32s
 ╭ ? Which fixture should it use? ─────────╮ ─▶ answer_space
 │ (fixtures/a)  (fixtures/b)  [Other…]    │
 ╰─────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│ Message this sub-space…                 (↑) │ ─▶ send_to (its own mode, no chips)
╰──────────────────────────────────────────────╯
```

- The strip replaces the progress card, the "Working" line and the
  "Queued…" note over the composer; the Run warning and the chat error
  stay as notes under it.
- "Waiting for your answer ↓" is line 1 while a question waits; a tap
  scrolls to the card.
- The sub-space tree at the top of the chat is tappable to the same screen;
  a long press still copies the id.
- No per-subagent Stop: the protocol has none.

## Appendix: optimistic sends, answers and starts (0.1.29)

Accepted (2026-11-21). What you do shows before the host answers, as on
the desktop; nothing waits on the round trip, nothing is lost silently.

```
Send                                  Approve                 Answer
             Sending…                          Sending…        ╭ ◌ Answered: SQLite ╮
   ╭ and fix the tests ╮      ╭ Plan approved, implement it. ╮
╭──────────────────────────╮  (Approve) busy meanwhile          refused ─▶ the card
│ Add to the queue…        │                                    is back + error
╰──────────────────────────╯  field cleared at once

host ok {message}         ─▶ Sent, until the row with that id arrives ─▶ row
host ok {queued, position}─▶ Queued (· 3 in line), "· 1 queued" on the strip
refused / 15 s silence    ─▶ Not sent · why   ╭ and fix the tests ╮
                                                    (Retry) (Edit)

Start from Home
Home ──Start──▶ /space/pending_<n>, no slide      [☰]  Fix the login redirect  [✎]
                                                       on mac-A · Starting · Edit
                                                              ╭ Fix the login redirect ╮
                                                       ◌ Starting on mac-A…
                                                  ╭ Starting on the other device… ╮ (off)
   host ok {space} ─▶ route replaced with /space/<rs_id>
   refused         ─▶ Home, the goal back in the field, the error over the composer
```

- State: `src/state/pending.ts` (zustand, keyed by space); rules and words
  `src/ui/pending.ts`; the bubble `PendingRow` in `src/ui/SpaceChat.tsx`.
- A host that mirrors no rows: the bubble stays until a "Turn n: <text>"
  line past the send shows it was received. The sub-space screen matches
  by text and time (`read_space` carries no ids).
