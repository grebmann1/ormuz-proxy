/* Ormuz site — vanilla JS. Two responsibilities:
 * 1. Install-tab switcher with full keyboard nav.
 * 2. Right-rail TOC scrollspy via IntersectionObserver.
 * Both are progressive enhancement. The site is fully readable without JS.
 */
(function () {
  "use strict";

  // ---- 1. Header shadow on scroll -----------------------------------------
  var header = document.querySelector(".site-header");
  if (header) {
    var setShadow = function () {
      if (window.scrollY > 12) header.classList.add("is-scrolled");
      else header.classList.remove("is-scrolled");
    };
    setShadow();
    window.addEventListener("scroll", setShadow, { passive: true });
  }

  // ---- 2. Tabs ------------------------------------------------------------
  function initTabs(root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (t) {
      return document.getElementById(t.getAttribute("aria-controls"));
    });
    function activate(idx, focus) {
      tabs.forEach(function (t, i) {
        var on = i === idx;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.setAttribute("tabindex", on ? "0" : "-1");
        if (on && focus) t.focus();
        if (panels[i]) panels[i].classList.toggle("is-active", on);
      });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { activate(i, false); });
      t.addEventListener("keydown", function (e) {
        var k = e.key;
        var newIdx = -1;
        if (k === "ArrowRight") newIdx = (i + 1) % tabs.length;
        else if (k === "ArrowLeft") newIdx = (i - 1 + tabs.length) % tabs.length;
        else if (k === "Home") newIdx = 0;
        else if (k === "End") newIdx = tabs.length - 1;
        if (newIdx !== -1) {
          e.preventDefault();
          activate(newIdx, true);
        }
      });
    });
  }
  Array.prototype.slice
    .call(document.querySelectorAll('[data-tabs]'))
    .forEach(initTabs);

  // ---- 3. Docs TOC scrollspy ---------------------------------------------
  var tocLinks = Array.prototype.slice.call(
    document.querySelectorAll(".docs-toc a[href^='#']")
  );
  if (tocLinks.length && "IntersectionObserver" in window) {
    var headingMap = {};
    tocLinks.forEach(function (a) {
      var id = a.getAttribute("href").slice(1);
      var h = document.getElementById(id);
      if (h) headingMap[id] = a;
    });
    var headings = Object.keys(headingMap).map(function (id) {
      return document.getElementById(id);
    });
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      });
      // Pick the topmost visible heading.
      var ordered = headings.filter(function (h) {
        return visible.has(h.id);
      });
      if (!ordered.length) return;
      var current = ordered[0].id;
      tocLinks.forEach(function (a) {
        a.classList.toggle(
          "is-active",
          a.getAttribute("href") === "#" + current
        );
      });
    }, { rootMargin: "-80px 0px -70% 0px", threshold: [0, 1] });
    headings.forEach(function (h) { io.observe(h); });
  }

  // ---- 4. Code highlighter (tiny, hand-rolled) ----------------------------
  // Supports bash/shell, json, typescript/javascript. Outputs simple
  // span tokens with classes the stylesheet maps to colors.
  var BASH_KEYWORDS = /\b(curl|cd|npm|node|git|cp|mv|rm|chmod|export|echo|grep|tail|head|cat|sudo|mkdir|launchctl|networksetup|lsof|brew)\b/g;
  var TS_KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|throw|new|class|interface|type|import|export|from|async|await|true|false|null|undefined|this)\b/g;
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function highlightShell(src) {
    var out = "";
    var lines = src.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.replace(/^\s+/, "");
      if (trimmed.startsWith("#")) {
        out += '<span class="tok-c">' + escapeHtml(line) + "</span>";
      } else {
        var s = escapeHtml(line);
        s = s.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|'[^']*'|"[^"]*")/g,
          function (m) { return '<span class="tok-s">' + m + "</span>"; });
        s = s.replace(/(\s)(--?[a-zA-Z][\w-]*)/g,
          function (_, sp, flag) { return sp + '<span class="tok-f">' + flag + "</span>"; });
        s = s.replace(BASH_KEYWORDS,
          function (m) { return '<span class="tok-k">' + m + "</span>"; });
        s = s.replace(/\b(\d+)\b/g,
          function (m) { return '<span class="tok-n">' + m + "</span>"; });
        out += s;
      }
      if (i < lines.length - 1) out += "\n";
    }
    return out;
  }
  function highlightJson(src) {
    var s = escapeHtml(src);
    s = s.replace(/(&quot;[^&]*?&quot;|"[^"]*")/g,
      function (m) { return '<span class="tok-s">' + m + "</span>"; });
    s = s.replace(/\b(true|false|null)\b/g,
      function (m) { return '<span class="tok-k">' + m + "</span>"; });
    s = s.replace(/\b(\d+(?:\.\d+)?)\b/g,
      function (m) { return '<span class="tok-n">' + m + "</span>"; });
    return s;
  }
  function highlightTs(src) {
    var s = escapeHtml(src);
    s = s.replace(/(\/\/[^\n]*)/g,
      function (m) { return '<span class="tok-c">' + m + "</span>"; });
    s = s.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*`)/g,
      function (m) { return '<span class="tok-s">' + m + "</span>"; });
    s = s.replace(TS_KEYWORDS,
      function (m) { return '<span class="tok-k">' + m + "</span>"; });
    s = s.replace(/\b(\d+(?:\.\d+)?)\b/g,
      function (m) { return '<span class="tok-n">' + m + "</span>"; });
    return s;
  }
  Array.prototype.slice
    .call(document.querySelectorAll("pre code[data-lang]"))
    .forEach(function (el) {
      var lang = el.getAttribute("data-lang") || "";
      var raw = el.textContent;
      if (lang === "bash" || lang === "sh" || lang === "shell") {
        el.innerHTML = highlightShell(raw);
      } else if (lang === "json") {
        el.innerHTML = highlightJson(raw);
      } else if (lang === "ts" || lang === "typescript" || lang === "js" || lang === "javascript") {
        el.innerHTML = highlightTs(raw);
      }
    });
})();
