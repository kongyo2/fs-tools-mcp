import { formatRipgrepCountSummary } from "../utils/ripgrep.js";
import { plural } from "../utils/string.js";

export const DEFAULT_GREP_HEAD_LIMIT = 250;

export type GrepOutput = {
  mode?: "content" | "files_with_matches" | "count";
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  appliedLimit?: number;
  appliedOffset?: number;
};

/**
 * Parses a ripgrep content-mode output line to extract the file path.
 * Handles both line-numbered output (filepath:linenum:content) and
 * plain output (filepath:content), including Windows drive-letter paths.
 * Context lines are normalized to the same ":" separator via ripgrep's
 * --field-context-separator flag, so a single format covers both.
 */
export function parseRipgrepContentLine(
  line: string,
): { filePath: string; rest: string } | null {
  // Match line with line numbers: filepath:linenum:content
  const lineNumMatch = line.match(/^(.+?):(\d+):/);
  if (lineNumMatch) {
    return {
      filePath: lineNumMatch[1],
      rest: line.slice(lineNumMatch[1].length),
    };
  }
  // Fallback for no line numbers: filepath:content
  // Skip Windows drive letter (e.g., C:\...)
  const startIdx =
    line.length > 2 && line[1] === ":" && /^[a-zA-Z]$/.test(line[0]) ? 2 : 0;
  const colonIndex = line.indexOf(":", startIdx);
  if (colonIndex > 0) {
    return {
      filePath: line.slice(0, colonIndex),
      rest: line.slice(colonIndex),
    };
  }
  return null;
}

export function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit: number | undefined } {
  const safeOffset = Math.max(0, offset);
  if (limit === 0) {
    return { items: items.slice(safeOffset), appliedLimit: undefined };
  }
  const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_HEAD_LIMIT);
  const sliced = items.slice(safeOffset, safeOffset + effectiveLimit);
  const wasTruncated = items.length - safeOffset > effectiveLimit;
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) {
    parts.push(`limit: ${appliedLimit}`);
  }
  if (appliedOffset) {
    parts.push(`offset: ${appliedOffset}`);
  }
  return parts.join(", ");
}

export function renderGrepText(output: GrepOutput): string {
  const mode = output.mode ?? "files_with_matches";
  const limitInfo = formatLimitInfo(output.appliedLimit, output.appliedOffset);
  if (mode === "content") {
    const result = output.content || "No matches found";
    return limitInfo
      ? `${result}\n\n[Showing results with pagination = ${limitInfo}]`
      : result;
  }
  if (mode === "count") {
    const rawContent = output.content || "No matches found";
    return `${rawContent}\n\n${formatRipgrepCountSummary(output.numMatches ?? 0, output.numFiles ?? 0)}${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
  }
  if (output.numFiles === 0) {
    return "No files found";
  }
  return `Found ${output.numFiles} ${plural(output.numFiles, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${output.filenames.join("\n")}`;
}
