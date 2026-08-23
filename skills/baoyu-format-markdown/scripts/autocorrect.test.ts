import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { applyBasicCjkSpacing } from "./autocorrect";

test("applies CJK/Latin spacing without changing fenced or inline code", () => {
  const dir = mkdtempSync(join(tmpdir(), "baoyu-format-markdown-"));
  const filePath = join(dir, "article.md");
  writeFileSync(
    filePath,
    "中文English\n`中文English`\n\n```\n中文English\n```\n",
    "utf8",
  );

  expect(applyBasicCjkSpacing(filePath)).toBe(true);
  expect(readFileSync(filePath, "utf8")).toContain("中文 English");
  expect(readFileSync(filePath, "utf8")).toContain("`中文English`");
  expect(readFileSync(filePath, "utf8")).toContain("中文English\n```\n");
});
