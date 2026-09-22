import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { glob } from "../utils/glob.js";
import { expandPath, toRelativePath } from "../utils/path.js";
import { semanticNumber } from "../utils/semanticNumber.js";
import { validateSearchPath } from "./searchPath.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./toolAnnotations.js";
import { errorResult, unknownErrorResult } from "./toolResult.js";

const GLOB_TOOL_NAME = "fs_glob";
const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 1000;
const GLOB_TIMEOUT_MS = 60_000;

const inputSchema = z
  .object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        "The directory to search in. If not specified, the current working directory will be used.",
      ),
    limit: semanticNumber(
      z.number().int().positive().max(MAX_GLOB_LIMIT).optional(),
    ).describe(
      `Maximum number of files to return. Defaults to ${DEFAULT_GLOB_LIMIT}.`,
    ),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      "Number of files to skip before returning results, for pagination.",
    ),
  })
  .strict();

const outputSchema = z.object({
  durationMs: z.number(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  truncated: z.boolean(),
});

export function registerFsGlobTool(server: McpServer): void {
  server.registerTool(
    GLOB_TOOL_NAME,
    {
      title: "Glob Files",
      description: `Fast file pattern matching tool.

Usage:
- Supports glob patterns like "**/*.js" or "src/**/*.ts".
- Returns matching file paths sorted by modification time (newest first).
- Use this tool when you need to find files by name patterns.`,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ pattern, path, limit = DEFAULT_GLOB_LIMIT, offset = 0 }) => {
      try {
        if (path) {
          const pathError = await validateSearchPath({
            path,
            missingLabel: "Directory",
            requireDirectory: true,
          });
          if (pathError) {
            return errorResult(pathError);
          }
        }

        const start = Date.now();
        const result = await glob(
          pattern,
          path ? expandPath(path) : process.cwd(),
          { limit, offset },
          AbortSignal.timeout(GLOB_TIMEOUT_MS),
        );
        const filenames = result.files.map(toRelativePath);
        const output = {
          filenames,
          durationMs: Date.now() - start,
          numFiles: filenames.length,
          truncated: result.truncated,
        };
        return {
          content: [
            {
              type: "text" as const,
              text:
                filenames.length === 0
                  ? "No files found"
                  : [
                      ...filenames,
                      ...(result.truncated
                        ? [
                            "(Results are truncated. Consider using a more specific path or pattern, or increase the offset to paginate.)",
                          ]
                        : []),
                    ].join("\n"),
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return unknownErrorResult(error);
      }
    },
  );
}
