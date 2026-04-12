import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stat } from "node:fs/promises";
import { z } from "zod/v4";
import { FILE_NOT_FOUND_CWD_NOTE, suggestPathUnderCwd } from "../utils/file.js";
import { safeStat } from "../utils/fsResult.js";
import { expandPath, toRelativePath } from "../utils/path.js";
import { ripGrep } from "../utils/ripgrep.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";
import { semanticNumber } from "../utils/semanticNumber.js";
import { formatRipgrepCountSummary } from "../utils/ripgrep.js";
import { plural } from "../utils/string.js";

const GREP_TOOL_NAME = "fs_grep";
const VCS_DIRECTORIES_TO_EXCLUDE = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
] as const;
const DEFAULT_HEAD_LIMIT = 250;

const inputSchema = z
  .object({
    pattern: z
      .string()
      .describe(
        "The regular expression pattern to search for in file contents",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "File or directory to search in. Defaults to current working directory.",
      ),
    glob: z
      .string()
      .optional()
      .describe("Glob pattern to filter files (e.g. *.js, *.{ts,tsx})."),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .optional()
      .describe("Output mode. Defaults to files_with_matches."),
    "-B": semanticNumber(z.number().optional()).describe(
      "Number of lines to show before each match.",
    ),
    "-A": semanticNumber(z.number().optional()).describe(
      "Number of lines to show after each match.",
    ),
    "-C": semanticNumber(z.number().optional()).describe("Alias for context."),
    context: semanticNumber(z.number().optional()).describe(
      "Number of lines to show before and after each match.",
    ),
    "-n": semanticBoolean(z.boolean().optional()).describe(
      "Show line numbers in output. Defaults to true for content mode.",
    ),
    "-i": semanticBoolean(z.boolean().optional()).describe(
      "Case insensitive search.",
    ),
    type: z.string().optional().describe("File type to search (rg --type)."),
    head_limit: semanticNumber(
      z.number().int().nonnegative().optional(),
    ).describe(
      "Limit output to first N lines/entries. Defaults to 250 when unspecified. Pass 0 for unlimited.",
    ),
    offset: semanticNumber(
      z.number().int().nonnegative().optional(),
    ).describe("Skip first N lines/entries before applying head_limit."),
    multiline: semanticBoolean(z.boolean().optional()).describe(
      "Enable multiline mode.",
    ),
  })
  .strict();

const outputSchema = z.object({
  mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  content: z.string().optional(),
  numLines: z.number().optional(),
  numMatches: z.number().optional(),
  appliedLimit: z.number().optional(),
  appliedOffset: z.number().optional(),
});

export function registerFsGrepTool(server: McpServer): void {
  server.registerTool(
    GREP_TOOL_NAME,
    {
      title: "Grep Search",
      description: `A powerful search tool built on ripgrep.

Usage:
- Supports full regex syntax.
- Filter files with glob or type.
- Output modes: content, files_with_matches, count.
- Use multiline: true for cross-line matches.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (input.path) {
          const absolutePath = expandPath(input.path);
          const statResult = await safeStat(absolutePath);
          if (statResult.isErr()) {
            if (statResult.error.code === "ENOENT") {
              const cwdSuggestion = await suggestPathUnderCwd(absolutePath);
              let message = `Path does not exist: ${input.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`;
              if (cwdSuggestion) {
                message += ` Did you mean ${cwdSuggestion}?`;
              }
              return errorResult(message);
            }
            return errorResult(
              `Cannot access path: ${statResult.error.message}`,
            );
          }
        }

        const output = await runGrep(input);
        return {
          content: [{ type: "text", text: renderGrepText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );
}

async function runGrep(
  input: z.infer<typeof inputSchema>,
): Promise<z.infer<typeof outputSchema>> {
  const {
    pattern,
    path,
    glob,
    type,
    output_mode = "files_with_matches",
    "-B": contextBefore,
    "-A": contextAfter,
    "-C": contextC,
    context,
    "-n": showLineNumbers = true,
    "-i": caseInsensitive = false,
    head_limit,
    offset = 0,
    multiline = false,
  } = input;

  const absolutePath = path ? expandPath(path) : process.cwd();
  const args = ["--hidden"];
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`);
  }
  args.push("--max-columns", "500");
  if (multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (caseInsensitive) {
    args.push("-i");
  }
  if (output_mode === "files_with_matches") {
    args.push("-l");
  } else if (output_mode === "count") {
    args.push("-c");
  }
  if (showLineNumbers && output_mode === "content") {
    args.push("-n");
  }
  if (output_mode === "content") {
    if (context !== undefined) {
      args.push("-C", String(context));
    } else if (contextC !== undefined) {
      args.push("-C", String(contextC));
    } else {
      if (contextBefore !== undefined) {
        args.push("-B", String(contextBefore));
      }
      if (contextAfter !== undefined) {
        args.push("-A", String(contextAfter));
      }
    }
  }
  if (pattern.startsWith("-")) {
    args.push("-e", pattern);
  } else {
    args.push(pattern);
  }
  if (type) {
    args.push("--type", type);
  }
  if (glob) {
    const rawPatterns = glob.split(/\s+/);
    for (const rawPattern of rawPatterns) {
      if (!rawPattern) {
        continue;
      }
      const patterns =
        rawPattern.includes("{") && rawPattern.includes("}")
          ? [rawPattern]
          : rawPattern.split(",").filter(Boolean);
      for (const globPattern of patterns) {
        args.push("--glob", globPattern);
      }
    }
  }

  const results = await ripGrep(
    args,
    absolutePath,
    AbortSignal.timeout(60_000),
  );

  if (output_mode === "content") {
    const limited = applyHeadLimit(results, head_limit, offset);
    const fileSet = new Set<string>();
    const finalLines = limited.items.map((line) => {
      const parsed = parseRipgrepContentLine(line);
      if (parsed) {
        const rel = toRelativePath(parsed.filePath);
        fileSet.add(rel);
        return `${rel}${parsed.rest}`;
      }
      return line;
    });
    const uniqueFiles = [...fileSet];
    return {
      mode: "content",
      numFiles: uniqueFiles.length,
      filenames: uniqueFiles,
      content: finalLines.join("\n"),
      numLines: finalLines.length,
      ...(limited.appliedLimit !== undefined
        ? { appliedLimit: limited.appliedLimit }
        : {}),
      ...(offset > 0 ? { appliedOffset: offset } : {}),
    };
  }

  if (output_mode === "count") {
    const limited = applyHeadLimit(results, head_limit, offset);
    const finalCountLines = limited.items.map((line) => {
      const colonIndex = line.lastIndexOf(":");
      if (colonIndex > 0) {
        return `${toRelativePath(line.slice(0, colonIndex))}${line.slice(colonIndex)}`;
      }
      return line;
    });
    let totalMatches = 0;
    let fileCount = 0;
    for (const line of finalCountLines) {
      const colonIndex = line.lastIndexOf(":");
      if (colonIndex > 0) {
        const count = Number.parseInt(line.slice(colonIndex + 1), 10);
        if (!Number.isNaN(count)) {
          totalMatches += count;
          fileCount += 1;
        }
      }
    }
    return {
      mode: "count",
      numFiles: fileCount,
      filenames: [],
      content: finalCountLines.join("\n"),
      numMatches: totalMatches,
      ...(limited.appliedLimit !== undefined
        ? { appliedLimit: limited.appliedLimit }
        : {}),
      ...(offset > 0 ? { appliedOffset: offset } : {}),
    };
  }

  const stats = await Promise.allSettled(
    results.map(async (file) => await stat(file)),
  );
  const sortedMatches = results
    .map(
      (file, index) =>
        [
          file,
          stats[index]?.status === "fulfilled"
            ? (stats[index].value.mtimeMs ?? 0)
            : 0,
        ] as const,
    )
    .sort((left, right) => {
      const timeComparison = right[1] - left[1];
      return timeComparison === 0
        ? left[0].localeCompare(right[0])
        : timeComparison;
    })
    .map(([file]) => file);
  const limited = applyHeadLimit(sortedMatches, head_limit, offset);
  const relativeMatches = limited.items.map(toRelativePath);
  return {
    mode: "files_with_matches",
    filenames: relativeMatches,
    numFiles: relativeMatches.length,
    ...(limited.appliedLimit !== undefined
      ? { appliedLimit: limited.appliedLimit }
      : {}),
    ...(offset > 0 ? { appliedOffset: offset } : {}),
  };
}

/**
 * Parses a ripgrep content-mode output line to extract the file path.
 * Handles both line-numbered output (filepath:linenum:content) and
 * plain output (filepath:content), including Windows drive-letter paths.
 */
function parseRipgrepContentLine(
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

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit: number | undefined } {
  const safeOffset = Math.max(0, offset);
  if (limit === 0) {
    return { items: items.slice(safeOffset), appliedLimit: undefined };
  }
  const effectiveLimit = Math.max(1, limit ?? DEFAULT_HEAD_LIMIT);
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

function renderGrepText(output: z.infer<typeof outputSchema>): string {
  const mode = output.mode ?? "files_with_matches";
  if (mode === "content") {
    const result = output.content || "No matches found";
    const limitInfo = formatLimitInfo(
      output.appliedLimit,
      output.appliedOffset,
    );
    return limitInfo
      ? `${result}\n\n[Showing results with pagination = ${limitInfo}]`
      : result;
  }
  if (mode === "count") {
    const rawContent = output.content || "No matches found";
    const limitInfo = formatLimitInfo(
      output.appliedLimit,
      output.appliedOffset,
    );
    return `${rawContent}\n\n${formatRipgrepCountSummary(output.numMatches ?? 0, output.numFiles ?? 0)}${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
  }
  const limitInfo = formatLimitInfo(output.appliedLimit, output.appliedOffset);
  if (output.numFiles === 0) {
    return "No files found";
  }
  return `Found ${output.numFiles} ${plural(output.numFiles, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${output.filenames.join("\n")}`;
}

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
