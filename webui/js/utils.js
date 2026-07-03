/* ── Pi Agent WebUI · Utility functions module ────────────────────────── */

/**
 * Escape HTML special characters.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Render Markdown text to HTML. Supports headings, code blocks (with optional
 * language class), inline code, bold, italic, unordered/ordered lists,
 * paragraphs, line breaks, and tables.
 * @param {string} text - Raw Markdown
 * @returns {string} HTML string
 */
export function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  // Headings (must come before other block replacements)
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Code blocks: ```lang\n...\n``` → <pre><code class="language-...">...</code></pre>
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) =>
      `<pre class="code-block"><button class="copy-code-btn" title="Copy code">📋</button>` +
      (lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "") +
      `<code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(code)}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  // Wrap consecutive <li> that aren't inside <ul> into <ol>
  html = html.replace(
    /(?:<li>.*<\/li>\n?)+(?=<ul|<li)/g,
    "<ol>$&</ol>"
  );

  // Tables: simple pipe-based tables
  html = html.replace(
    /^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm,
    (_, headerRow, bodyRows) => {
      const headers = headerRow
        .split("|")
        .map((h) => h.trim())
        .filter(Boolean);
      const thead = `<thead><tr>${headers
        .map((h) => `<th>${h}</th>`)
        .join("")}</tr></thead>`;
      const rows = bodyRows
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((row) => {
          const cells = row
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean);
          return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
        })
        .join("");
      return `<table>${thead}<tbody>${rows}</tbody></table>`;
    }
  );

  // Paragraphs: double newline breaks
  html = html.replace(/\n\n/g, "</p><p>");

  // Line breaks
  html = html.replace(/\n/g, "<br>");

  return `<p>${html}</p>`;
}

/**
 * Smooth-scroll the chat container to the bottom.
 */
export function scrollToBottom() {
  const el = document.getElementById("chatContainer");
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

/**
 * Format a timestamp as a relative or absolute time string.
 * @param {string|number} timestamp - ISO string or Unix ms
 * @returns {string}
 */
export function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/**
 * Generate a short unique ID (6–8 alphanumeric chars).
 * @returns {string}
 */
export function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} delay - Milliseconds
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Copy text to clipboard with fallback.
 * @param {string} text
 * @returns {Promise<boolean>} Whether copy succeeded
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / insecure contexts
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}
