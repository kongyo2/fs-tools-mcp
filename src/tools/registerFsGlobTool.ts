import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stat } from "node:fs/promises";
import { z } from "zod/v4";
import { glob } from "../utils/glob.js";
import { FILE_NOT_FOUND_CWD_NOTE, suggestPathUnderCwd } from "../utils/file.js";
import { expandPath, toRelativePath } from "../utils/path.js";

const GLOB_TOOL_NAME = "fs_glob";

const inputSchema = z.object({
  pattern: z.string().describe("The glob pattern to match files against"),
  path: z.string().optional().describe("The directory to search in. If not specified, the current working directory will be used.")
}).strict();

const outputSchema = z.object({
  durationMs: z.number(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  truncated: z.boolean()
});

export function registerFsGlobTool(server: McpServer): void {
  server.registerTool(
    GLOB_TOOL_NAME,
    {
      title: "Glob Files",
      description: `Fast file pattern matching tool.

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
        openWorldHint: false
      }
    },
    async ({ pattern, path }) => {
      try {
        if (path) {
          const absolutePath = expandPath(path);
          let stats;
          try {
            stats = await stat(absolutePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              const cwdSuggestion = await suggestPathUnderCwd(absolutePath);
              let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`;
              if (cwdSuggestion) {
                message += ` Did you mean ${cwdSuggestion}?`;
              }
              return errorResult(message);
            }
            throw error;
          }
          if (!stats.isDirectory()) {
            return errorResult(`Path is not a directory: ${path}`);
          }
        }

        const start = Date.now();
        const result = await glob(pattern, path ? expandPath(path) : process.cwd(), { limit: 100, offset: 0 }, AbortSignal.timeout(60_000));
        const filenames = result.files.map(toRelativePath);
        const output = {
          filenames,
          durationMs: Date.now() - start,
          numFiles: filenames.length,
          truncated: result.truncated
        };
        return {
          content: [
            {
              type: "text",
              text: filenames.length === 0 ? "No files found" : [...filenames, ...(result.truncated ? ["(Results are truncated. Consider using a more specific path or pattern.)"] : [])].join("\n")
            }
          ],
          structuredContent: output
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );
}

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}
