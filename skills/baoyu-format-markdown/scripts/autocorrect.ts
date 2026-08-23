import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function resolveAutocorrectBin(): string | null {
  try {
    const packageJson = require.resolve("autocorrect-node/package.json");
    const manifest = JSON.parse(
      readFileSync(packageJson, "utf8"),
    ) as {
      bin?: string | Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const hasOptionalNativeBinding = Object.keys(
      manifest.optionalDependencies ?? {},
    ).some((name) => {
      try {
        require.resolve(name);
        return true;
      } catch {
        return false;
      }
    });
    if (!hasOptionalNativeBinding) return null;
    const bin = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin?.autocorrect
        ?? manifest.bin?.["autocorrect-node"]
        ?? Object.values(manifest.bin ?? {})[0];
    return bin ? join(dirname(packageJson), bin) : null;
  } catch {
    return null;
  }
}

const CJK = "\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF";
const CJK_TO_LATIN = new RegExp(`([${CJK}])([A-Za-z0-9])`, "g");
const LATIN_TO_CJK = new RegExp(`([A-Za-z0-9])([${CJK}])`, "g");

export function applyBasicCjkSpacing(filePath: string): boolean {
  const original = readFileSync(filePath, "utf8");
  let inFence = false;
  const formatted = original.split("\n").map((line) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    // Keep inline code literal while covering the common prose case on
    // platforms where autocorrect-node has no published native artifact.
    return line
      .split(/(`+[^`]*`+)/g)
      .map((segment, index) =>
        index % 2 === 1
          ? segment
          : segment.replace(CJK_TO_LATIN, "$1 $2").replace(LATIN_TO_CJK, "$1 $2"),
      )
      .join("");
  }).join("\n");

  if (formatted !== original) writeFileSync(filePath, formatted, "utf8");
  return true;
}

export function applyAutocorrect(filePath: string): boolean {
  const bin = resolveAutocorrectBin();
  if (bin) {
    const result = spawnSync(process.execPath, [bin, "--fix", filePath], {
      stdio: "inherit",
      cwd: dirname(fileURLToPath(import.meta.url)),
    });
    if (result.status === 0) return true;
  }

  console.warn(
    "[format] autocorrect-node native binding unavailable; using basic CJK/Latin spacing fallback",
  );
  return applyBasicCjkSpacing(filePath);
}
