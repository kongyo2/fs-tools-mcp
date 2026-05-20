import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import fg from "fast-glob";
import { ripGrep } from "./ripgrep.js";

export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string;
  relativePattern: string;
} {
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) {
    return { baseDir: dirname(pattern), relativePattern: basename(pattern) };
  }
  const staticPrefix = pattern.slice(0, match.index);
  const lastSeparatorIndex = Math.max(
    staticPrefix.lastIndexOf("/"),
    staticPrefix.lastIndexOf(sep),
  );
  if (lastSeparatorIndex === -1) {
    return { baseDir: "", relativePattern: pattern };
  }
  let baseDir = staticPrefix.slice(0, lastSeparatorIndex);
  const relativePattern = pattern.slice(lastSeparatorIndex + 1);
  if (baseDir === "" && lastSeparatorIndex === 0) {
    baseDir = "/";
  }
  if (process.platform === "win32" && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = `${baseDir}${sep}`;
  }
  return { baseDir, relativePattern };
}

async function fastGlobFallback(
  pattern: string,
  cwd: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const entries = await fg(pattern, {
    cwd,
    dot:
      (process.env.FS_TOOLS_MCP_GLOB_HIDDEN ?? "true").toLowerCase() !==
      "false",
    onlyFiles: true,
    absolute: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  if (abortSignal.aborted) {
    throw new Error("Glob search aborted");
  }
  const withMtime = await Promise.all(
    entries.map(async (entry) => {
      try {
        const stats = await stat(entry);
        return [entry, stats.mtimeMs ?? 0] as const;
      } catch {
        return [entry, 0] as const;
      }
    }),
  );
  return withMtime
    .sort((a, b) => {
      const cmp = b[1] - a[1];
      return cmp === 0 ? a[0].localeCompare(b[0]) : cmp;
    })
    .map(([entry]) => entry);
}

export async function glob(
  filePattern: string,
  cwd: string,
  options: { limit: number; offset: number },
  abortSignal: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd;
  let searchPattern = filePattern;
  if (isAbsolute(filePattern)) {
    const extracted = extractGlobBaseDirectory(filePattern);
    if (extracted.baseDir) {
      searchDir = extracted.baseDir;
      searchPattern = extracted.relativePattern;
    }
  }

  const noIgnore =
    (process.env.FS_TOOLS_MCP_GLOB_NO_IGNORE ?? "true").toLowerCase() !==
    "false";
  const hidden =
    (process.env.FS_TOOLS_MCP_GLOB_HIDDEN ?? "true").toLowerCase() !== "false";
  const args = [
    "--files",
    "--glob",
    searchPattern,
    "--sort=modified",
    ...(noIgnore ? ["--no-ignore"] : []),
    ...(hidden ? ["--hidden"] : []),
  ];
  let absolutePaths: string[];
  try {
    const allPaths = await ripGrep(args, searchDir, abortSignal);
    absolutePaths = allPaths.map((path) =>
      isAbsolute(path) ? path : join(searchDir, path),
    );
  } catch (error) {
    if (abortSignal.aborted) {
      throw error;
    }
    absolutePaths = await fastGlobFallback(
      searchPattern,
      searchDir,
      abortSignal,
    );
  }
  const truncated = absolutePaths.length > options.offset + options.limit;
  return {
    files: absolutePaths.slice(options.offset, options.offset + options.limit),
    truncated,
  };
}
