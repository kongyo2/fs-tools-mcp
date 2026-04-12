import { basename, dirname, isAbsolute, join, sep } from "node:path";
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
  const allPaths = await ripGrep(args, searchDir, abortSignal);
  const absolutePaths = allPaths.map((path) =>
    isAbsolute(path) ? path : join(searchDir, path),
  );
  const truncated = absolutePaths.length > options.offset + options.limit;
  return {
    files: absolutePaths.slice(options.offset, options.offset + options.limit),
    truncated,
  };
}
