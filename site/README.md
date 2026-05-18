# Ormuz site

Static landing + docs site for Ormuz, served by nginx in Docker. Markdown
in the repo's `docs/` directory is rendered to HTML at build time by a
small Node script (`build.mjs` using `marked`). No client-side rendering,
no framework, no analytics.

## Build and run with Docker

The Docker build context must be the **repository root** so the build
stage can read `docs/*.md`:

```bash
# from repo root
docker build -f site/Dockerfile -t ormuz-site:latest .
docker run --rm -p 8080:80 ormuz-site:latest
# open http://localhost:8080
```

TLS terminates at the deployment platform; nginx listens on plain HTTP.

## Develop locally without Docker

```bash
cd site
npm install
node build.mjs
python3 -m http.server --directory dist 8080
# open http://localhost:8080
```

`build.mjs` reads markdown from `../docs/` relative to `site/`, so edits
to the repo's docs flow through on the next rebuild.

## Layout and design

The single source of truth for layout, copy, color, type, spacing, and
the strait visual is [`DESIGN.md`](DESIGN.md). Edit that first, then
update `src/` to match.

- `src/index.html` — landing page, hand-authored.
- `src/docs/index.html` — docs hub, hand-authored.
- `src/assets/styles.css` — sole stylesheet, design tokens at the top.
- `src/assets/site.js` — install-tab keyboard nav, TOC scrollspy, and a
  tiny hand-rolled syntax highlighter for shell/JSON/TypeScript.
- `src/assets/strait.svg` — hero visual (also inlined into index.html).
- `build.mjs` — markdown -> HTML, ToC generation, page templating.

The three docs pages (`how-it-works.html`, `install.html`,
`architecture.html`) are rendered from `docs/*.md` at build time. Edit
the markdown, not the rendered HTML.

## Code highlighting

A hand-rolled regex highlighter in `src/assets/site.js` supports shell,
JSON, and TypeScript — the only languages in the docs. Spans with classes
mapped to design tokens. No Prism, no Shiki.
