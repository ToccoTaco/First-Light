```
   ·  ✦   ·          ·      ✦
      DESIGN DIRECTION  ·  Project "First Light"
   ─────────────────────────────────────────────
   Navy is the void.  Gold is the signal.
   ✦        ·        ·            ·     ✦
```

## 0 · How to use this

This is the **Phase 3 visual spec** for the ND Experimental Propulsion timeline tool. It defines the look: color tokens, type, the mission-control vocabulary, and the nebula background. Hand this to the Phase 3 UI work; wire DHTMLX's template hooks (`task_class`, etc.) to the tokens and mappings below. Nothing here changes the engine, the data model, or any logic — it's purely how the tool *looks and feels*.

The whole aesthetic rests on one rule: **gold is scarce.** It appears only on things that carry meaning — the critical path, the next gate, the countdown, the one primary action on a screen. Everything else is calm navy and negative space. If gold starts feeling common, the design has drifted. Restraint *is* the style.

---

## 1 · The concept

Real mission control is quiet, dark, and data-first — not busy with space clip-art. The "space" feeling here comes from four things, in order of importance: deep navy canvas, gold used only as signal, monospace telemetry readouts, and a single faint nebula living in the background. That's the entire kit. Resist adding more.

Notre Dame's own palette does most of the work for us: navy `#0C2340` already reads as deep space, and Dome Gold `#C99700` reads as starlight and gold instrumentation. We're not theming *over* the ND brand — the ND brand *is* the theme.

---

## 2 · Color tokens

Define each as a CSS custom property, in **both** mode sets (see §6). These are the source of truth — don't hand-pick colors in components.

| Token | Dark (default) | Light |
|---|---|---|
| `--canvas` (page) | `#08111F` | `#F6F4EE` |
| `--surface` (panel/card) | `#0C2340` | `#FFFFFF` |
| `--surface-raised` | `#123056` | `#FFFFFF` |
| `--border-hair` | `#1C3252` | `#D9DEE8` |
| `--text-primary` | `#EDEBE3` (warm white) | `#0C2340` |
| `--text-secondary` | `#A9B8CE` | `#5A6B85` |
| `--text-telemetry` (mono, dim) | `#7C8DA8` | `#8A93A5` |
| `--gold` (signal) | `#C99700` | `#C99700` |
| `--gold-glow` (emphasis/next gate) | `#D39F10` | `#B4870C` |
| `--gold-text` (gold used as *text*) | `#E7B633` | `#9A7500` |
| `--bar-active` (in progress) | `#2C6FB0` | `#143865` |
| `--blocked-fg` | `#E39A92` | `#A0392C` |
| `--blocked-bg` | `rgba(180,84,74,0.18)` | `#F7E1DD` |

**The one accessibility rule that matters:** gold has poor contrast as *text* on a light background. So in light mode, gold is for **fills** (bars, gate diamonds) and `--gold-text` carries any gold-colored *words*; navy carries emphasized text. In dark mode gold works as both. Never put `#C99700` text directly on white.

Completed work should **recede**, not celebrate: done bars drop to `--text-secondary` at reduced opacity with no gold. Attention belongs on active and critical work, not on what's already finished.

---

## 3 · Typography

Two families, no more.

- **Interface:** a clean geometric sans (Inter, or the system's closest) for everything structural — labels, panels, buttons, task names.
- **Telemetry:** a monospace for every *number and identifier* — the T-minus countdown, dates, slack values, task ids (`engines.injector-test` already looks like a readout in mono), and small-caps section labels.

That sans/mono split is the single strongest "mission control" cue in the whole design, and it costs nothing. Weights: regular and medium only — never heavy.

---

## 4 · The mission-control vocabulary

Concrete, subtle touches. This is the full list — don't invent more.

- **Countdown as T-minus.** The dashboard hero reads `T–47 DAYS` in mono gold, with the target below ("to first engine hotfire"). Recompute to the next unpinned gate automatically.
- **Gates are gold diamonds.** Review and test gates render as rotated gold squares on the timeline. The *next upcoming* gate gets a faint `--gold-glow` halo in dark mode — the one place a soft glow is allowed.
- **The critical path is the gold thread.** Critical-path bars fill with `--gold`; it's the live wire running through the chart. Because gold is scarce everywhere else, the eye follows it naturally.
- **`guess` tasks are hatched.** Low-confidence tasks get a diagonal hatch fill (see §7), so the honesty of the rolling-wave plan is *visible* at a glance.
- **Console labels.** Section headers in small-caps monospace with wide letter-spacing, like panel labels on a flight console. Use sparingly — one per region.

---

## 5 · ⇒ The nebula background  (the atmosphere)

The nebula is what makes the tool feel like it's floating in deep space rather than sitting on a dark-gray dashboard — but it only works if it's **barely there.** The test: you should feel it in the empty margins and behind the countdown, and you should *never* notice it behind body text. If you can read a task name and also see nebula through it, it's too strong.

**Where it lives:** the page canvas *only* (`--canvas`). Panels, cards, and the chart grid sit on top as **solid** `--surface` navy, so the nebula shows through in the gutters and around the dashboard hero — the negative space — and nowhere that holds text. This single rule (nebula on canvas, solid surfaces above) is what keeps it subtle instead of muddy.

**The recipe (dark mode)** — a starting point to tune, not a hard spec. Two deep clouds in opposite corners plus a whisper of gold dust, all layered into the near-black navy:

```css
.canvas {
  background-color: #08111F;
  background-image:
    radial-gradient(60% 50% at 12% 8%,  rgba(83, 74,183, 0.14), transparent 60%),  /* violet cloud, upper-left  */
    radial-gradient(55% 45% at 88% 92%, rgba(28, 79,143, 0.16), transparent 60%),  /* blue cloud, lower-right    */
    radial-gradient(45% 40% at 72% 22%, rgba(201,151,  0, 0.05), transparent 55%); /* faint gold dust, very sparse */
  background-attachment: fixed;   /* clouds stay put; content scrolls over them */
}
```

Taste guardrails so it lands: keep every cloud's peak opacity **at or below ~0.16** — when in doubt, weaker. Push the glows into the **corners**, off-center, so it reads as distant nebula, not a spotlight. The gold dust is a *whisper* (~0.05) — it should be almost subliminal, just enough warmth to tie the background to the accent. `background-attachment: fixed` matters: the clouds hold still while content scrolls over them, which sells the "window into space" feeling.

**Light mode:** the nebula essentially stands down. Daytime is clear. Either drop it entirely, or reduce to an extremely faint cool wash in two corners (~0.03–0.04 opacity of `#1C4F8F`) — nothing that competes with a bright, legible workspace. Don't force a nebula onto white; honesty over consistency here.

**Optional flourishes (v1.1, only if they stay tasteful):**
- A *sparse* starfield — a dozen or so 1px dots at 20–35% white opacity, in the dashboard header band only, never across the whole chart.
- A *very* slow drift on the clouds (60–120s loop) for a living feel — but it **must** respect `prefers-reduced-motion: reduce` and default to static if unsure. A still nebula is completely fine; a gimmicky one is not.

Definition of done for the background: it looks like deep space seen through a window, calm enough that you forget it's there until you look at the empty space — and text contrast is never once compromised.

---

## 6 · Dark / light toggle

Both palettes in §2 become two token sets. The toggle flips `data-mode="dark" | "light"` on the root element; every color resolves from the active set, so no component knows or cares which mode it's in. Requirements:

- **Default to dark** — it's the tool's identity. Light mode is the daytime / projector / print-friendly alternative.
- **Persist the choice** so a lead's preference sticks between visits.
- Build the two-mode token set from the *start* of the styling work, not as a retrofit — done this way the toggle is nearly free; bolted on later it's a rewrite.

---

## 7 · Element → style mapping

Wire these to the renderer (DHTMLX `task_class` gives per-task CSS; gates/milestones use custom markers):

| Element (from the data model) | Treatment |
|---|---|
| Critical-path task | `--gold` fill — the gold thread |
| In-progress task | `--bar-active` fill |
| Not-started task | outline / low-emphasis fill, `--border-hair` |
| Done task | recedes: `--text-secondary`, reduced opacity, no gold |
| `blocked` status | `--blocked-fg` on `--blocked-bg` badge/bar + a dot |
| `confidence: guess` | diagonal hatch overlay: `repeating-linear-gradient(45deg, #24456E, #24456E 5px, #15304F 5px, #15304F 10px)` (dark) / light-navy hatch (light) |
| Gate (`review` / `test`) | gold diamond; next upcoming gate gets a `--gold-glow` halo |
| Milestone | smaller outline diamond |
| Summary / parent | slim bracket-style bar in `--text-secondary` |

Where a task is *both* critical and something else (e.g. in-progress), critical wins the fill — the gold thread must stay unbroken.

---

## 8 · The one-line brief for making it good

Deep-navy calm, gold only where it means something, telemetry in mono, and a nebula you feel more than see. When a choice is ambiguous, choose the quieter option — "too cluttered" is the only way this look fails.

```
   ✦        ·           ·      ·    ✦
      Make it feel like mission control
        the night before a launch.
   ·        ✦        ·          ✦
```
