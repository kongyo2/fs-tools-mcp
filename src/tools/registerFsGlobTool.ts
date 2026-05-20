import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { glob } from "../utils/glob.js";
import { FILE_NOT_FOUND_CWD_NOTE, suggestPathUnderCwd } from "../utils/file.js";
import { safeStat } from "../utils/fsResult.js";
import { expandPath, toRelativePath } from "../utils/path.js";
import { semanticNumber } from "../utils/semanticNumber.js";

const GLOB_TOOL_NAME = "fs_glob";
const DEFAULT_LIMIT = 1000;

const inputSchema = z
  .object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        "The directory to search in. If not specified, the current working directory will be used.",
      ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      `Maximum number of files to return (default ${DEFAULT_LIMIT}).`,
    ),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      "Skip first N matches before applying limit (default 0).",
    ),
  })
  .strict();

const outputSchema = z.object({
  durationMs: z.number(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  truncated: z.boolean(),
  appliedLimit: z.number().optional(),
  appliedOffset: z.number().optional(),
});

export function registerFsGlobTool(server: McpServer): void {
  server.registerTool(
    GLOB_TOOL_NAME,
    {
      title: "Glob Files",
      description: `Fast file pattern matching tool that works with any codebase size.

Usage:
- Supports glob patterns like "**/*.js" or "src/**/*.ts".
- Returns matching file paths sorted by modification time.
- Use this tool when you need to find files by name patterns.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pattern, path, limit, offset }) => {
      try {
        const effectiveLimit = limit ?? DEFAULT_LIMIT;
        const effectiveOffset = offset ?? 0;
        if (path) {
          const absolutePath = expandPath(path);
          const statResult = await safeStat(absolutePath);
          if (statResult.isErr()) {
            if (statResult.error.code === "ENOENT") {
              const cwdSuggestion = await suggestPathUnderCwd(absolutePath);
              let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`;
              if (cwdSuggestion) {
                message += ` Did you mean ${cwdSuggestion}?`;
              }
              return errorResult(message);
            }
            return errorResult(
              `Cannot access path: ${statResult.error.message}`,
            );
          }
          if (!statResult.value.isDirectory()) {
            return errorResult(`Path is not a directory: ${path}`);
          }
        }

        const start = Date.now();
        const result = await glob(
          pattern,
          path ? expandPath(path) : process.cwd(),
          { limit: effectiveLimit, offset: effectiveOffset },
          AbortSignal.timeout(60_000),
        );
        const filenames = result.files.map(toRelativePath);
        const output = {
          filenames,
          durationMs: Date.now() - start,
          numFiles: filenames.length,
          truncated: result.truncated,
          ...(effectiveLimit !== DEFAULT_LIMIT
            ? { appliedLimit: effectiveLimit }
            : {}),
          ...(effectiveOffset > 0 ? { appliedOffset: effectiveOffset } : {}),
        };
        return {
          content: [
            {
              type: "text",
              text:
                filenames.length === 0
                  ? "No files found"
                  : [
                      ...filenames,
                      ...(result.truncated
                        ? [
                            "(Results are truncated. Use offset/limit to paginate or use a more specific pattern.)",
                          ]
                        : []),
                    ].join("\n"),
            },
          ],
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

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
