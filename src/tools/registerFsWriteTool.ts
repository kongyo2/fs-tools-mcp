import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname } from "node:path";
import { z } from "zod/v4";
import { getPatchForDisplay } from "../utils/diff.js";
import { getFileModificationTime, writeTextContent } from "../utils/file.js";
import { readFileSyncWithMetadata } from "../utils/fileRead.js";
import { safeMkdir, toFsError } from "../utils/fsResult.js";
import { expandPath } from "../utils/path.js";
import type { SessionState } from "../state.js";

const FILE_WRITE_TOOL_NAME = "fs_write";

const inputSchema = z
  .object({
    file_path: z.string().describe("The absolute path to the file to write"),
    content: z.string().describe("The content to write to the file"),
  })
  .strict();

const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

const outputSchema = z.object({
  type: z.enum(["create", "update"]),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(hunkSchema),
  originalFile: z.string().nullable(),
});

export function registerFsWriteTool(
  server: McpServer,
  state: SessionState,
): void {
  server.registerTool(
    FILE_WRITE_TOOL_NAME,
    {
      title: "Write File",
      description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- Prefer fs_edit for modifying existing files and fs_write for creation or complete rewrites.
- Parent directories are created automatically.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file_path, content }) => {
      try {
        const fullFilePath = expandPath(file_path);
        const mkdirResult = await safeMkdir(dirname(fullFilePath));
        if (mkdirResult.isErr()) {
          return errorResult(
            `Failed to create directory: ${mkdirResult.error.message}`,
          );
        }

        let meta: ReturnType<typeof readFileSyncWithMetadata> | null;
        try {
          meta = readFileSyncWithMetadata(fullFilePath);
        } catch (error) {
          const fsErr = toFsError(error);
          if (fsErr.code === "ENOENT") {
            meta = null;
          } else {
            return errorResult(`Cannot read existing file: ${fsErr.message}`);
          }
        }

        // Honor explicit newlines in `content` instead of forcing LF — the
        // caller may pass CRLF intentionally (Windows scripts, etc.).
        writeTextContent(
          fullFilePath,
          content,
          meta?.encoding ?? "utf8",
          "LF",
          meta?.detected,
        );

        state.readFileState.set(fullFilePath, {
          content,
          timestamp: getFileModificationTime(fullFilePath),
          offset: undefined,
          limit: undefined,
        });

        if (meta !== null) {
          const patch = getPatchForDisplay({
            filePath: file_path,
            fileContents: meta.content,
            edits: [
              {
                old_string: meta.content,
                new_string: content,
                replace_all: false,
              },
            ],
          });
          const data = {
            type: "update" as const,
            filePath: file_path,
            content,
            structuredPatch: patch,
            originalFile: meta.content,
          };
          return {
            content: [
              {
                type: "text",
                text: `The file ${file_path} has been updated successfully.`,
              },
            ],
            structuredContent: data,
          };
        }

        const data = {
          type: "create" as const,
          filePath: file_path,
          content,
          structuredPatch: [],
          originalFile: null,
        };
        return {
          content: [
            {
              type: "text",
              text: `File created successfully at: ${file_path}`,
            },
          ],
          structuredContent: data,
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
