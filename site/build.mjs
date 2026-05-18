/**
 * Ormuz site build script.
 *
 * Inputs:
 *   ../docs/how-it-works.md
 *   ../docs/install.md
 *   ../docs/architecture.md
 *   src/index.html, src/docs/index.html (hand-authored, copied verbatim)
 *   src/assets/* (copied verbatim)
 *
 * Outputs (under ./dist/):
 *   index.html
 *   docs/index.html
 *   docs/how-it-works.html
 *   docs/install.html
 *   docs/architecture.html
 *   assets/styles.css, assets/site.js, assets/strait.svg, assets/favicon.svg
 */

import { mkdir, readFile, writeFile, copyFile, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "src");
const DIST = path.join(__dirname, "dist");

// Resolve docs source. Default: ../docs (the repo's docs dir).
// In the Docker builder image we copy the repo's `docs/` to `../docs`
// relative to the working dir, so this resolution stays the same.
const DOCS_SRC = path.resolve(__dirname, "..", "docs");

// ------------------------------------------------------------------ utilities

const HTML_ESC = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
           .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

// ------------------------------------------------------------ marked renderer

// Custom renderer: headings get slug ids and a permalink anchor; tables get
// a wrapping div for horizontal scroll; code blocks emit data-lang.
const renderer = new marked.Renderer();
const usedSlugs = new Map();
function uniqueSlug(base) {
  const used = usedSlugs.get(base) || 0;
  const s = used === 0 ? base : `${base}-${used + 1}`;
  usedSlugs.set(base, used + 1);
  return s;
}

renderer.heading = function (text, level, raw) {
  // Strip any inline markup tags first (e.g. <code>) for slug purposes.
  const slugBase = slugify(raw || text.replace(/<[^>]+>/g, ""));
  const id = uniqueSlug(slugBase);
  return `<h${level} id="${id}"><a class="permalink" href="#${id}" aria-label="Permalink to this section">#</a>${text}</h${level}>\n`;
};

renderer.table = function (header, body) {
  return `<div class="table-wrap"><table>\n<thead>${header}</thead>\n<tbody>${body}</tbody>\n</table></div>\n`;
};

renderer.code = function (code, infostring) {
  const lang = (infostring || "").split(/\s+/)[0] || "";
  const escaped = HTML_ESC(code);
  const langAttr = lang ? ` data-lang="${HTML_ESC(lang)}"` : "";
  return `<pre><code${langAttr}>${escaped}</code></pre>\n`;
};

renderer.link = function (href, title, text) {
  const isExternal = /^https?:\/\//i.test(href || "");
  const titleAttr = title ? ` title="${HTML_ESC(title)}"` : "";
  const targetAttr = isExternal ? ` target="_blank" rel="noopener noreferrer"` : "";
  return `<a href="${HTML_ESC(href)}"${titleAttr}${targetAttr}>${text}</a>`;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: false,
});

// -------------------------------------------------- Markdown to HTML pipeline

/**
 * Render one markdown file into:
 *   { title, html, toc }
 * where:
 *   title = first <h1> text content (raw markdown text, plain)
 *   html  = remaining body HTML (h1 stripped)
 *   toc   = ordered list of { level, id, text } for h2/h3
 */
async function renderMarkdown(filePath) {
  // Reset slug map per-file so different docs can share the same heading slugs.
  usedSlugs.clear();

  const md = await readFile(filePath, "utf8");

  // Extract first H1 from raw markdown to use as page title.
  // Docs are well-formed; the first line is always `# Title`.
  let title = "";
  let body = md;
  const m = md.match(/^[ \t]*#\s+(.+?)\s*$/m);
  if (m) {
    title = m[1].trim();
    // Remove the entire H1 line(s) (and the blank line after it, if any).
    body = md.replace(/^[ \t]*#\s+.+?\r?\n(?:\r?\n)?/, "");
  }

  const html = marked.parse(body);

  // Build a TOC from the rendered HTML by walking <h2>/<h3>.
  const toc = [];
  const headingRe = /<h([23])\s+id="([^"]+)">([\s\S]*?)<\/h\1>/g;
  let hm;
  while ((hm = headingRe.exec(html)) !== null) {
    const level = Number(hm[1]);
    const id = hm[2];
    // Strip the permalink anchor and any inline tags from the visible text.
    const inner = hm[3]
      .replace(/<a class="permalink"[^>]*>[^<]*<\/a>/, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    toc.push({ level, id, text: inner });
  }

  return { title, html, toc };
}

// ------------------------------------------------------- Docs page templating

function renderTocHtml(toc) {
  if (!toc.length) return "";
  const items = toc
    .map(
      (h) =>
        `<li class="lvl-${h.level}"><a href="#${h.id}">${HTML_ESC(h.text)}</a></li>`
    )
    .join("\n");
  return `<aside class="docs-toc"><nav aria-label="On this page"><p class="docs-toc__title">On this page</p><ol>\n${items}\n</ol></nav></aside>`;
}

function renderSidebarHtml(activeSlug) {
  const items = [
    { slug: "index", label: "Overview", href: "/docs/" },
    { slug: "how-it-works", label: "How it works", href: "/docs/how-it-works.html" },
    { slug: "install", label: "Install", href: "/docs/install.html" },
    { slug: "architecture", label: "Architecture", href: "/docs/architecture.html" },
  ];
  const links = items
    .map(
      (it) =>
        `<li><a href="${it.href}"${it.slug === activeSlug ? ' aria-current="page"' : ""}>${it.label}</a></li>`
    )
    .join("\n");
  return `
    <p class="docs-nav__group-label">Docs</p>
    <ul>
${links}
    </ul>
    <p class="docs-nav__group-label">Project</p>
    <ul>
      <li><a href="https://github.com/grebmann1/ormuz-proxy" target="_blank" rel="noopener noreferrer">GitHub</a></li>
      <li><a href="https://github.com/grebmann1/ormuz-proxy/issues" target="_blank" rel="noopener noreferrer">Issues</a></li>
      <li><a href="https://github.com/grebmann1/ormuz-proxy/blob/main/README.md" target="_blank" rel="noopener noreferrer">README</a></li>
    </ul>
  `;
}

const HEADER_HTML = `
<a class="skip-link" href="#main">Skip to main content</a>

<header class="site-header" role="banner">
  <div class="container site-header__inner">
    <a class="brand" href="/" aria-label="Ormuz home">
      <span>Ormuz</span>
      <svg class="brand__glyph" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
          <path d="M9 7 C 5 12, 5 20, 9 25"/>
          <path d="M23 7 C 27 12, 27 20, 23 25"/>
        </g>
        <circle cx="16" cy="16" r="2" fill="currentColor"/>
      </svg>
    </a>
    <nav class="nav-primary" aria-label="Primary">
      <a href="/docs/">Docs</a>
      <a href="https://github.com/grebmann1/ormuz-proxy" target="_blank" rel="noopener noreferrer">
        GitHub
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        <span class="sr-only">(opens in new tab)</span>
      </a>
    </nav>
  </div>
</header>
`;

const FOOTER_HTML = `
<footer class="site-footer" role="contentinfo">
  <div class="container site-footer__inner">
    <p class="site-footer__left">Ormuz<span class="sep">·</span>MIT License<span class="sep">·</span>2026</p>
    <nav class="site-footer__nav" aria-label="Footer">
      <a href="https://github.com/grebmann1/ormuz-proxy" target="_blank" rel="noopener noreferrer">GitHub
        <svg class="icon-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        <span class="sr-only">(opens in new tab)</span>
      </a>
      <a href="/docs/">Docs</a>
      <a href="https://github.com/grebmann1/ormuz-proxy/issues" target="_blank" rel="noopener noreferrer">Issues
        <svg class="icon-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        <span class="sr-only">(opens in new tab)</span>
      </a>
    </nav>
  </div>
</footer>
`;

function buildDocPageHtml({ slug, title, body, toc, sourceFilename }) {
  const editUrl = `https://github.com/grebmann1/ormuz-proxy/blob/main/docs/${sourceFilename}`;
  const sidebar = renderSidebarHtml(slug);
  const tocHtml = renderTocHtml(toc);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${HTML_ESC(title)} — Ormuz</title>
<meta name="description" content="${HTML_ESC(title)} — Ormuz documentation.">
<meta name="theme-color" content="#fbfaf6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a141c" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${HTML_ESC(title)} — Ormuz">
<meta property="og:description" content="Ormuz documentation: ${HTML_ESC(title)}.">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
${HEADER_HTML}
<details class="docs-mobile-nav">
  <summary>${HTML_ESC(title)}</summary>
  <nav class="docs-nav" aria-label="Docs sidebar (mobile)">
${sidebar}
  </nav>
</details>

<main id="main">
  <div class="docs-shell">
    <div class="docs-grid">
      <aside class="docs-rail">
        <nav class="docs-nav" aria-label="Docs sidebar">
${sidebar}
        </nav>
      </aside>

      <article class="docs-main">
        <div class="docs-main__inner">
          <header class="docs-page-header">
            <p class="docs-page-header__eyebrow">Docs</p>
            <h1>${HTML_ESC(title)}</h1>
            <p class="docs-page-header__edit"><a href="${editUrl}" target="_blank" rel="noopener noreferrer">Edit on GitHub -&gt;<span class="sr-only">(opens in new tab)</span></a></p>
          </header>

          <div class="prose">
${body}
          </div>

          <footer class="docs-page-footer">Last updated from main · Ormuz docs</footer>
        </div>
      </article>

      ${tocHtml}
    </div>
  </div>
</main>
${FOOTER_HTML}
<script src="/assets/site.js" defer></script>
</body>
</html>
`;
}

// ----------------------------------------------------------------- internal links

/**
 * Rewrite intra-docs links so that markdown-style relative paths
 * (e.g. `how-it-works.md` or `./architecture.md`) resolve correctly to
 * the rendered `/docs/<name>.html` URLs.
 */
function rewriteDocsInternalLinks(html) {
  return html.replace(
    /href="(\.\/)?([a-z0-9-]+)\.md(#[^"]*)?"/gi,
    (_, _dot, name, hash) => `href="/docs/${name}.html${hash || ""}"`
  );
}

// ----------------------------------------------------------------------- main

async function main() {
  console.log("[ormuz-site] cleaning dist/");
  if (await exists(DIST)) {
    await rm(DIST, { recursive: true, force: true });
  }
  await mkdir(DIST, { recursive: true });
  await mkdir(path.join(DIST, "docs"), { recursive: true });
  await mkdir(path.join(DIST, "assets"), { recursive: true });

  // 1. Copy assets verbatim.
  console.log("[ormuz-site] copying assets/");
  await copyDir(path.join(SRC, "assets"), path.join(DIST, "assets"));

  // 2. Copy hand-authored pages.
  console.log("[ormuz-site] copying hand-authored pages");
  await copyFile(path.join(SRC, "index.html"), path.join(DIST, "index.html"));
  await copyFile(
    path.join(SRC, "docs", "index.html"),
    path.join(DIST, "docs", "index.html")
  );

  // 3. Render docs from markdown.
  const pages = [
    { slug: "how-it-works", source: "how-it-works.md" },
    { slug: "install", source: "install.md" },
    { slug: "architecture", source: "architecture.md" },
  ];

  for (const page of pages) {
    const inPath = path.join(DOCS_SRC, page.source);
    if (!(await exists(inPath))) {
      throw new Error(`Missing markdown source: ${inPath}`);
    }
    console.log(`[ormuz-site] rendering ${page.source} -> docs/${page.slug}.html`);
    const { title, html, toc } = await renderMarkdown(inPath);
    const linked = rewriteDocsInternalLinks(html);
    const out = buildDocPageHtml({
      slug: page.slug,
      title,
      body: linked,
      toc,
      sourceFilename: page.source,
    });
    await writeFile(
      path.join(DIST, "docs", `${page.slug}.html`),
      out,
      "utf8"
    );
  }

  // 4. Add a simple permissive robots.txt — allowed by spec.
  await writeFile(
    path.join(DIST, "robots.txt"),
    "User-agent: *\nAllow: /\n",
    "utf8"
  );

  console.log("[ormuz-site] done. output: " + DIST);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
