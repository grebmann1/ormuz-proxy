# Ormuz public site — design + copy spec

The build-ready spec for the Ormuz landing + docs site. Treat this as the
single source of truth for layout, copy, color, type, and visual moments.
Don't invent extra sections, pages, or interactions. For what's intentionally
absent, see Section 9.

The site is a static landing page plus three docs pages, served by nginx in a
Docker container. Markdown in `docs/*.md` is rendered to HTML at build time
by a small Node script. No framework, no bundler, no analytics.

---

## 1. Site map

Five HTML files. Paths relative to `site/src/`.

| URL | Source | Purpose |
| --- | --- | --- |
| `/index.html` | hand-authored | Landing page |
| `/docs/index.html` | hand-authored | Docs hub: short intro + 3 link cards |
| `/docs/how-it-works.html` | rendered from `docs/how-it-works.md` | "How Ormuz Works" |
| `/docs/install.html` | rendered from `docs/install.md` | "Installing Ormuz" |
| `/docs/architecture.html` | rendered from `docs/architecture.md` | "Architecture" |

`/docs/` exists so the docs sidebar always has a home anchor. No 404 page,
blog, changelog, or community page.

Header nav on every page: wordmark `Ormuz` (logo, links to `/`), `Docs`
(links to `/docs/`), `GitHub` (external, new tab,
`https://github.com/grebmann1/ormuz-proxy`). Footer is identical on every
page; see 2.8.

---

## 2. Landing page — section by section

Top-to-bottom order. Max content width `min(1120px, 92vw)`. Section
backgrounds alternate `--paper` / `--paper-2` for vertical rhythm.

### 2.1 Header (sticky, all pages)

Height ~64px. Background `--paper`. Bottom border `1px solid --hairline`.
Three regions inside the content-width container:

- Left: wordmark `Ormuz` (mono 500, color `--ink`). To its immediate right,
  a 14px inline SVG glyph `( · )` in `--strait` (two outline parens with a
  small dot between). This is the only place the "strait" mark appears in
  chrome.
- Center: empty.
- Right: text links separated by 32px. Order: `Docs`, then `GitHub` (with a
  14px trailing external-link icon).

On scroll past 12px the header gains `--shadow-1`. No transparency, no
transforms.

### 2.2 Hero

Two-column on `>=900px`: left 56% (copy), right 44% (strait visual,
Section 5). On mobile they stack, visual second.

Eyebrow (small caps, tracked, `--tide`):

```
A PROXY FOR YOUR LLM GATEWAY
```

Headline (display, `--ink`, 600). Hard `<br>` between lines:

```
Calm traffic
through a narrow strait.
```

Subhead (body-large, `--ink-2`, max-width 52ch):

```
Ormuz sits between your code and the LLM gateway. It paces requests
with a token bucket, queues bursts in FIFO, and retries upstream 429s
so your tools stop hitting the rate limit.
```

CTA row, 32px above subhead:

- Primary button: label `Install in 30 seconds`, links to `#install`. Fill
  `--strait`, text `--paper`, `--radius-md`, padding 12/20.
- Secondary link: label `Read the docs ->`, links to `/docs/`. Color
  `--strait`. Arrow is literal `->` glyph, no SVG.

Below CTAs, single meta line, caption size, `--ink-3`:

```
Node 20+   ·   MIT licensed   ·   ~1.6k LOC
```

Rationale: the maritime metaphor leads only in the headline. The subhead
translates it into engineering specifics within five seconds.

### 2.3 What it does (4 cards)

Section heading (h2): `What Ormuz does`

Subhead (body, `--ink-2`, max-width 60ch):

```
Four jobs, executed by a single Node process you can run as a sidecar
or as a system-wide proxy.
```

Grid: 2x2 on `>=900px`, 1-up on mobile. Card: padding 28px, background
`--paper`, border `1px solid --hairline`, `--radius-md`. No shadow at
rest, `--shadow-1` on hover with a `-2px` Y translate (120ms).

Each card: 28px outline icon top-left in `--strait`, then card title (h3),
then 8px gap, then body (body-small, `--ink-2`).

Card 1 — icon `gauge` (Lucide):

```
Title: Token-bucket pacing
Body:  Per-key rate control with a configurable safety factor.
       Buckets start full, so short bursts pass; sustained
       traffic gets paced to your real RPM budget.
```

Card 2 — icon `list-ordered`:

```
Title: Bounded FIFO queueing
Body:  Bursts wait in a per-key queue with a hard depth cap and a
       projected-wait cap. When the line is too long, Ormuz fails
       fast with a local 429 instead of stranding the request.
```

Card 3 — icon `arrow-right-left`:

```
Title: HTTPS via CONNECT
Body:  Acts as a system-wide proxy. Tunnels TLS byte-for-byte
       without termination — no custom CA, no MITM. Per-host
       rate limits apply to every CONNECT.
```

Card 4 — icon `activity`:

```
Title: Prometheus metrics
Body:  Queue depth, dequeue wait, tokens available, and outcome
       counters per bucket key. One scrape endpoint, ready for
       your existing dashboards.
```

### 2.4 How it works (diagram strip)

Heading (h2): `How it works`

Subhead (body, `--ink-2`):

```
One Node process, one scheduler, one path that's easy to reason about
under load.
```

Stylized ASCII diagram inside a tinted container: background `--code-bg`,
padding 24px, `--radius-md`, max-width 100%, horizontal scroll on overflow.
Render verbatim, preserve spacing exactly:

```
   client                    Ormuz                       LLM gateway
   ------     /v1/...     -----------------     pace      -------------
   tools  ─────────────▶  route → bucket  ─────────────▶  upstream API
   sdks                   ↓                                ▲
                          token bucket + FIFO queue        │
                          ↓                                │
                          429 retry on first attempt ──────┘
```

Below, one paragraph (body, `--ink-2`, max-width 70ch):

```
Each request is mapped to a bucket key, admitted by the scheduler, and
forwarded with undici. If the gateway answers 429, Ormuz pauses that
bucket, re-queues the request once, then gives up cleanly.
```

Trailing link (caption, `--strait`): `Read the full request lifecycle ->`
linking to `/docs/how-it-works.html`.

### 2.5 Code example

Heading (h2): `Drop it into the loop you already have`

No subhead. Filename strip above the block: `Terminal` (mono 12px,
`--ink-3`). Block uses standard code styling (Section 4). Verbatim from
the README:

```bash
curl -X POST "http://localhost:8787/v1/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer REQUEST_PROVIDED_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

Caption below (body-small, `--ink-2`):

```
Same request shape as the upstream. Ormuz strips routing headers,
forwards the rest, and streams the response back.
```

### 2.6 Install (anchor `#install`)

Heading (h2): `Install in 30 seconds`

Subhead (body, `--ink-2`, max-width 60ch):

```
macOS today. Linux supported as a sidecar; system-wide install lands soon.
```

Tabbed code panel. Two tabs: `Sidecar` (default), `System-wide (macOS)`.
Active tab: 2px bottom border in `--strait`, label color `--ink`.
Inactive: border `--hairline`, label `--ink-3`. Both blocks live in the
DOM; only the active panel is `display: block`. Use semantic tab markup;
keyboard support per Section 7.

Tab 1 — `Sidecar`:

```bash
git clone https://github.com/grebmann1/ormuz-proxy.git
cd ormuz-proxy
npm install
npm run dev
# Ormuz now listens on http://localhost:8787
```

Tab 2 — `System-wide (macOS)`:

```bash
git clone https://github.com/grebmann1/ormuz-proxy.git
cd ormuz-proxy
npm install
npm run install:autostart        # launchd + zsh env vars
npm run install:systemproxy      # PAC + macOS auto-proxy
```

Trailing link (body, `--strait`): `See the full install guide ->` linking
to `/docs/install.html`.

### 2.7 Why the name? (the metaphor, contained)

Single column, narrow max-width 52ch.

Eyebrow (small caps, `--tide`): `ASIDE`

Heading (use h3 size, not h2): `Why "Ormuz"?`

Body (body, `--ink-2`):

```
The Strait of Hormuz is the narrow chokepoint that about a fifth of
the world's seaborne oil passes through. Tankers don't fight the
strait — they line up, take their slot, and move on.

This proxy is the strait between your code and the LLM gateway:
narrow on purpose, with a queue when traffic gets dense, and the
ships still get through.
```

No CTA. No image. Section ends.

Rationale: containment. The metaphor pays off here, after the engineering
has already landed.

### 2.8 Footer (all pages)

Background `--paper-3`, top border `1px solid --hairline`, padding 32px
top/bottom. Flex row on desktop, stacked on mobile.

Left: `Ormuz · MIT License · 2026` (wordmark mono, body for separators,
text `--ink-3`).

Right: inline links separated by 24px, `--ink-3`:

- `GitHub` -> `https://github.com/grebmann1/ormuz-proxy` (external)
- `Docs` -> `/docs/`
- `Issues` -> `https://github.com/grebmann1/ormuz-proxy/issues` (external)

No social, email, or newsletter.

---

## 3. Docs pages

### 3.1 Shared docs layout

Three columns on `>=1080px`:

- Left rail: 240px, sticky 24px from top. Background `--paper`, right
  border `1px solid --hairline`.
- Center: `1fr`, max-width 760px. Padding 48/24/16px L/R at desktop /
  tablet / mobile.
- Right rail (TOC): 220px, sticky 24px from top. Visible on `>=1200px`
  only. No background, no border.

Below 1080px the left rail collapses into a `<details>` block at the top
of the page, summary text shows the current page title. The right rail
hides below 1200px (would crowd prose).

#### Left rail (identical on every docs page)

```
Docs
  Overview
  How it works
  Install
  Architecture

Project
  GitHub
  Issues
  README
```

Targets:
- `Overview` -> `/docs/`
- `How it works` -> `/docs/how-it-works.html`
- `Install` -> `/docs/install.html`
- `Architecture` -> `/docs/architecture.html`
- `GitHub` -> `https://github.com/grebmann1/ormuz-proxy`
- `Issues` -> `https://github.com/grebmann1/ormuz-proxy/issues`
- `README` -> `https://github.com/grebmann1/ormuz-proxy/blob/main/README.md`

Active page: text `--ink`, weight 600, 2px left border `--strait` extending
the line height. Inactive: `--ink-2`. Hover: `--ink`. Group labels (`Docs`,
`Project`) are caption-size small caps, tracked, `--ink-3`, 16px above each
group, 8px below.

#### Right rail (auto-generated TOC)

Ordered list of every `<h2>` and `<h3>` in the rendered page, indented by
level. Caption size, `--ink-2` inactive, `--ink` for the section currently
in the viewport. Build script generates this from rendered headings.

#### Page header band (above prose)

- Eyebrow: `DOCS` (small caps, `--tide`).
- Page title (h1): from the first `<h1>` in the source markdown.
- Below the title, a single line (caption, `--ink-3`):

  `Edit on GitHub ->`

  links to
  `https://github.com/grebmann1/ormuz-proxy/blob/main/docs/<filename>.md`.
  For `/docs/index.html` (hand-authored), point at the README:
  `https://github.com/grebmann1/ormuz-proxy/blob/main/README.md`.

The build script must strip the source's first `<h1>` from the rendered
prose so it doesn't repeat below the band.

#### Page footer band (below prose)

Single line (caption, `--ink-3`), 48px above the global site footer:

```
Last updated from main · Ormuz docs
```

Static text. No timestamp wiring in v1.

### 3.2 Docs hub (`/docs/index.html`)

Hand-authored, three-column layout but with right rail hidden (no long
prose to TOC).

Page title (h1): `Documentation`

Intro (body, `--ink-2`, max-width 60ch):

```
Three docs cover Ormuz end to end. Start with How it works to see the
request lifecycle. Reach for Install when you're wiring it into a
machine. Open Architecture when you need to change the proxy itself.
```

Three link cards stacked (or 3-up on `>=900px`). Card: padding 24px,
background `--paper`, border `1px solid --hairline`, `--radius-md`. Title
h3, body body-small `--ink-2`. Whole card is the link; hover lifts with
`--shadow-1` and `-2px` Y.

```
Card 1 -> /docs/how-it-works.html
Title: How Ormuz Works
Body:  Request lifecycle, the rate-limiting model, and what
       happens to a CONNECT tunnel from the moment a client opens it.

Card 2 -> /docs/install.html
Title: Installing Ormuz
Body:  Two macOS install layers, what each one catches, and the
       failure modes that bite during real installs.

Card 3 -> /docs/architecture.html
Title: Architecture
Body:  Component map, sequence diagrams, and the design decisions
       you should know before changing core code.
```

### 3.3 Rendering rules for `docs/*.md`

- **`<h1>`**: extracted into the page-header band; removed from prose.
- **`<h2>`/`<h3>`**: indexed by the right-rail TOC; each gets a slugified
  `id` (lowercase, non-alphanum -> `-`, dedupe with suffix `-2`, `-3`...).
  On heading hover, a `#` permalink glyph appears at the right edge in
  `--ink-3`.
- **Paragraphs**: body, `--ink-2`. Width inherited from center column.
- **Lists**: 24px left padding, 8px between items.
- **Tables**: full center-column width. Header row background `--paper-2`,
  1px bottom border `--hairline`. Body rows 1px bottom `--hairline`.
  Cells padding 12/16. Tables overflow horizontally on mobile inside a
  scroll container; do not collapse to stacked rows.
- **Inline code**: background `--code-bg`, padding 1/6, `--radius-sm`,
  font-size 0.9em, color `--ink`.
- **Code blocks**: background `--code-bg`, padding 20/24, `--radius-md`,
  font-size 14px, line-height 1.6, overflow-x auto. No language pill in
  v1; build script may emit `data-lang` for later.
- **ASCII diagrams**: the fenced blocks in `how-it-works.md` and
  `architecture.md` already render correctly through the standard code
  styling. Don't special-case them.
- **Blockquotes**: 3px left border `--tide`, 16px left padding, `--ink-2`.
- **`<hr>`**: 1px `--hairline`, 32px top/bottom margin.
- **Links**: `--strait`, no underline at rest, underline on hover.
  External links (not the site's own host) get a 12px trailing
  external-link icon `--ink-3`.

---

## 4. Visual system

### 4.1 Color tokens

**Light mode** (default). Hex values exact.

| Token | Hex | Usage |
| --- | --- | --- |
| `--ink` | `#0b1721` | Primary text, headlines |
| `--ink-2` | `#3a4a57` | Secondary body |
| `--ink-3` | `#6b7a85` | Captions, muted labels |
| `--paper` | `#fbfaf6` | Page + header background |
| `--paper-2` | `#f3f1ea` | Alternating section background |
| `--paper-3` | `#ebe8df` | Footer background |
| `--hairline` | `#dcd6c5` | Borders, dividers |
| `--strait` | `#0e4a6b` | Primary action, links, sidebar active |
| `--tide` | `#0f7a8a` | Eyebrow, secondary accent, blockquote border |
| `--coast` | `#c1672b` | Tertiary accent (hero ships only) |
| `--accent` | `#0e4a6b` | Alias of `--strait` |
| `--code-bg` | `#eef0e7` | Code blocks, ASCII diagrams |
| `--shadow-1` | `0 1px 2px rgba(11,23,33,.06), 0 4px 12px rgba(11,23,33,.06)` | Card hover, header on scroll |

**Dark mode**, applied via `@media (prefers-color-scheme: dark)`. No toggle
in v1 (Section 9).

| Token | Hex |
| --- | --- |
| `--ink` | `#e9eef2` |
| `--ink-2` | `#a9b4bd` |
| `--ink-3` | `#7a858f` |
| `--paper` | `#0a141c` |
| `--paper-2` | `#0e1a23` |
| `--paper-3` | `#08111a` |
| `--hairline` | `#1d2b36` |
| `--strait` | `#5db4cf` |
| `--tide` | `#7ed3df` |
| `--coast` | `#e3a06f` |
| `--accent` | `#5db4cf` |
| `--code-bg` | `#0f1a23` |
| `--shadow-1` | `0 1px 2px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.35)` |

The palette anchors on navy (`--strait`) and teal (`--tide`); paper tones
are warm-cream to soften the dev-tools register. `--coast` appears only on
the hero ships.

### 4.2 Typography

- **Sans**: Inter (400/500/600). Fallback: `Inter, system-ui,
  -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
- **Mono**: JetBrains Mono (400/500). Fallback: `"JetBrains Mono",
  "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`.

Both via `@font-face` from a CDN (Google Fonts is fine). The `Ormuz`
wordmark uses mono 500 to set it apart from body sans.

Type scale (rem-based, 1rem = 16px):

| Level | Size | Line-height | Weight | Tracking | Notes |
| --- | --- | --- | --- | --- | --- |
| `display` | 3.5rem | 1.05 | 600 | -0.02em | Hero headline only |
| `h1` | 2.25rem | 1.15 | 600 | -0.015em | Docs page titles |
| `h2` | 1.5rem | 1.25 | 600 | -0.01em | Section headings |
| `h3` | 1.125rem | 1.4 | 600 | 0 | Card titles, sub-section heads |
| `body-large` | 1.125rem | 1.6 | 400 | 0 | Hero subhead |
| `body` | 1rem | 1.7 | 400 | 0 | Default prose |
| `body-small` | 0.9375rem | 1.6 | 400 | 0 | Card bodies |
| `caption` | 0.8125rem | 1.5 | 500 | 0.06em (when SC) | Eyebrows, footer, TOC |

Below 640px: `display` shrinks to 2.5rem, `h1` shrinks to 1.875rem; others
hold.

Eyebrows: small-caps via `font-feature-settings: "smcp"` if supported,
else `text-transform: uppercase` with the tracked letter-spacing above.

### 4.3 Spacing scale

Single scale, used for margin/padding/gap. No ad-hoc px:

```
--space-1: 4px   --space-4: 16px   --space-7: 48px
--space-2: 8px   --space-5: 24px   --space-8: 64px
--space-3: 12px  --space-6: 32px   --space-9: 96px
```

Section vertical padding: `--space-9` desktop, `--space-7` mobile.

### 4.4 Radius and shadow

```
--radius-sm: 4px     (inline code, tiny pills)
--radius-md: 10px    (buttons, cards, code blocks)
--radius-lg: 16px    (reserved; not used in v1)

--shadow-0: none
--shadow-1: see token table       (cards on hover, header on scroll)
--shadow-2: reserved; not used in v1
```

Shadow at hover only, never at rest.

### 4.5 Iconography

Use **Lucide** (https://lucide.dev) inlined as SVG (paste at build, don't
fetch at runtime). All icons: `stroke="currentColor"`,
`stroke-width="1.75"`, no fill. Sizes: 20px default, 24px in card headers,
14px inline.

Lucide names used: `gauge`, `list-ordered`, `arrow-right-left`, `activity`,
`external-link`.

Header wordmark glyph `( · )` is custom inline SVG (not Lucide): two parens
at 1.75 stroke and a 2px-radius dot, all `--strait`. Hero strait visual is
its own SVG, Section 5.

---

## 5. Strait of Hormuz visual

The only visual flourish on the site. Lives in the hero right column, and
nowhere else. Tone: Caddy-quality SVG, not a children's-book illustration.
No labels on the map other than the two end-cap captions specified below.

### 5.1 Geometry

`viewBox="0 0 480 360"`. Scaled to fit the right column; on mobile sits
below copy at full container width capped at 420px.

- Background: rounded-rect 100% size, fill `--paper`, no stroke.
- Top land mass: bezier path occupying the top ~38% of the canvas. Fill
  `--paper-3`, stroke `--hairline` 1px. Bottom edge dips toward the
  right, forming the strait's upper bank.
- Bottom land mass: mirrors the top, occupying bottom ~38%. Same fill /
  stroke. Top edge rises toward the right.
- Channel: gap between land masses. ~96px wide at the left, ~36px at the
  right. Narrowing happens between x=240 and x=380.
- Bathymetry hint: 2-3 thin horizontal arcs inside the channel, stroke
  `--hairline`, `stroke-dasharray="2 6"`, `opacity=".4"`. Flow with the
  channel; end before reaching land.
- Three ship glyphs: equilateral triangles, 12px on a side, fill
  `--coast`, pointing left. Centerline placement:
  - Ship A: x=380, y=180 (entering the narrows from the right)
  - Ship B: x=300, y=178 (mid-narrows)
  - Ship C: x=180, y=182 (already through, spreading out)
- Right end-cap: 1px vertical bar 28px tall in `--tide` at x=460, y=166.
  Above it, `<text>` "GATEWAY", `fill="--ink-3"`, `font-size="9"`,
  letter-spacing 0.08em, `text-anchor="end"`.
- Left end-cap: mirrored at x=20, label "YOUR CODE",
  `text-anchor="start"`, same caption styling.

The two captions also serve as the alt-text equivalent. Mark the SVG with
`role="img"` and:

```
aria-label="Map of a narrow strait between your code and the LLM gateway,
with three small ships moving left through the strait."
```

### 5.2 Animation

Subtle, two motions, both gated by `prefers-reduced-motion: reduce`.

1. **Bob**: each ship gets a 2px vertical translate, ease-in-out, period
   4.0s, 0.4s phase offset between A/B/C so they don't move in lockstep.
2. **Drift**: each ship slowly translates left by 24px over 12s, then
   resets. Stagger starts so the strait always has at least one ship
   mid-narrows. Linear easing; bob and drift run simultaneously.

Either `<animateTransform>` or CSS `@keyframes` on the inline SVG. With
reduced motion, both stop and ships stay at initial positions. Zero
interactivity; no hover, no click.

---

## 6. Responsive behavior

| Token | px | Behavior |
| --- | --- | --- |
| `--bp-sm` | 640 | Below: single column; reduced display size |
| `--bp-md` | 900 | Hero becomes two-column; "What it does" cards 2x2 |
| `--bp-lg` | 1080 | Docs left rail appears; below: collapses to `<details>` |
| `--bp-xl` | 1200 | Docs right rail (TOC) appears |

Specific collapses:

- Header: link font-size shrinks to 14px and side padding -8px below 640px.
  No hamburger menu (only two links).
- Hero: copy and visual stack on mobile, copy first.
- Cards: 4-up on `>=900px` (2x2 default), 1-up below 640px.
- Diagram and code blocks: keep monospace, allow horizontal scroll. Don't
  shrink font below 13px on small screens.
- Install tabs: stack vertically below 480px (each tab full-width pill,
  panel spans full).
- Footer: rows stack on mobile, links wrap with 12px row gap.
- Docs left rail: `<details>` summary uses the active page title; open
  reveals the full nav. Right rail hides below 1200px and never moves.

---

## 7. Accessibility

- **Contrast**: WCAG 2.1 AA minimum for body and caption; AA Large for
  display. Verify the palette in 4.1 against `--paper` in both modes,
  including button text (`--paper` on `--strait`).
- **Skip link**: first focusable element on every page. `Skip to main
  content`, visually hidden until focused, then visible at top-left
  with `--strait` background and `--paper` text. Targets
  `<main id="main">`.
- **Landmarks**: every page has `<header>`, `<main id="main">`,
  `<footer>`. Docs pages also have `<nav aria-label="Docs sidebar">`
  for the left rail and `<nav aria-label="On this page">` for the right
  rail.
- **Headings**: exactly one `<h1>` per page. No skipped levels.
- **Focus**: 2px outline in `--strait` with 2px offset on every
  interactive element. Don't strip default outlines without a
  replacement.
- **Install tabs**: `role="tablist"`, each tab is `<button role="tab"
  aria-selected="..." aria-controls="...">`. Panels are `<div
  role="tabpanel" id="..." aria-labelledby="...">`. Keyboard:
  Left/Right arrows move focus and selection between tabs, Home/End
  jump to first/last. Inactive tabs have `tabindex="-1"`; active has
  `tabindex="0"`.
- **Docs sidebar**: plain `<nav>` with `<ul>`/`<li>`/`<a>`. Mobile
  collapsed version uses `<details><summary>`. Active link has
  `aria-current="page"`.
- **Hero SVG**: `role="img"` with the `aria-label` from 5.1.
  Decorative arcs/dashes have no `<title>`.
- **Reduced motion**: honor `prefers-reduced-motion: reduce` to disable
  the strait animation. No other motion exists.
- **Tab order**: skip link, header logo, header links, main interactive
  elements (CTAs, tabs), footer. Verify by tabbing without a mouse.
- **External links**: `target="_blank" rel="noopener noreferrer"`.
  Trailing icon is `aria-hidden="true"`; link ends with visually-hidden
  text `(opens in new tab)`.
- **Lang**: `<html lang="en">` on every page.
- **Forms**: none.

---

## 8. Build constraints

- Pure HTML, CSS, vanilla JS. No frameworks. No CSS preprocessor. No
  bundler. CSS is one file (`assets/styles.css`); JS is one file
  (`assets/site.js`).
- `assets/site.js` only handles two things: install-tab switching with
  keyboard support, and the right-rail scrollspy via
  `IntersectionObserver`. Both are progressive enhancements; the page
  is fully readable without JS.
- Markdown rendering at build time via `site/src/build.mjs` (a small
  Node script). For each `docs/*.md`:
  1. Render to HTML (suggest `marked` or `markdown-it`).
  2. Extract the first `<h1>` for the page-header band; remove it from
     the rendered body.
  3. Slugify all `<h2>`/`<h3>`, add `id`s and permalink glyphs.
  4. Walk headings to build a TOC `<ol>`.
  5. Inject body, page-header band, and TOC into the shared docs HTML
     shell template.
  6. Write to `site/src/docs/<slug>.html`.
- The build script must not require a network call. Markdown sources are
  local; fonts and icons are baked in.
- Asset paths absolute from site root (`/assets/styles.css`,
  `/assets/site.js`). No `<base>` tag.
- Server: nginx in a Docker container. The Dockerfile and `nginx.conf`
  are the build agent's deliverable; layout per the directory layout in
  the original task.
- No service worker, no PWA manifest. A `<meta name="theme-color">` is
  set to `--paper` (light) and to dark `--paper` via the standard
  `prefers-color-scheme` media attribute on a second meta tag.
- Favicon: a 32x32 SVG of the wordmark glyph `( · )` in `--strait` on
  transparent. `<link rel="icon" type="image/svg+xml"
  href="/assets/favicon.svg">`. No PNG fallback in v1.
- `og:image`: optional. If included, use the strait visual on a
  `--paper-2` plate at 1200x630. Always set `<meta property="og:title">`
  and `<meta property="og:description">` per page.

---

## 9. Out of scope (do not invent)

- **No analytics.** No GA, no Plausible, no first-party pixels. No
  outbound requests after initial load.
- **No cookie banner** (no cookies to disclose).
- **No newsletter signup, contact form, or email capture.**
- **No client-side search.** Docs are short; search would mean an index.
- **No dark-mode toggle UI.** The site honors `prefers-color-scheme`
  automatically; no manual switch.
- **No syntax highlighting.** Plain monospace on a tinted background.
- **No animations** beyond the strait visual and standard hover
  transitions on cards/links (12-150ms `transform` and `box-shadow`).
- **No copy-to-clipboard buttons** on code blocks.
- **No language switcher.** English only.
- **No sitemap.xml** in v1; the build agent may add a permissive
  `robots.txt` if trivial.
- **No live API status, metrics demo, or embedded sandbox.**

---

## 10. Decisions the user may want to override

- **Fonts**: Inter + JetBrains Mono. Alternatives: IBM Plex Sans + IBM
  Plex Mono (warmer); Geist + Geist Mono (more current).
- **Palette warmth**: paper tones are warm-cream. For a cooler base,
  swap `--paper` to `#f6f7f9` and `--paper-2` to `#eef0f3`; everything
  else holds.
- **Pun volume**: Section 2.7 commits to one paragraph. To dial down,
  drop the `( · )` wordmark glyph in header/footer. To dial up, promote
  the metaphor into the hero subhead. Default is contained.
- **Coast accent**: `--coast` (`#c1672b`) used only on hero ships. Drop
  entirely for a strict navy/teal palette; ships become `--tide`.
- **System-wide install tab**: labeled macOS-only on the landing.
  Alternative: label `System-wide`, let the docs page explain platform
  support.
- **Wordmark face**: mono (JetBrains Mono 500). Alternative: Inter 600
  for more "product" and less "tool" feel.

---

End of spec.
