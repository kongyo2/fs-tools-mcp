import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod/v4";
import type { SessionState } from "../state.js";
import { getPatchForDisplay } from "../utils/diff.js";
import { getFileModificationTime, writeTextContent } from "../utils/file.js";
import { readFileSyncWithMetadata } from "../utils/fileRead.js";
import { expandPath } from "../utils/path.js";

const FILE_WRITE_TOOL_NAME = "fs_write";
const FILE_UNEXPECTEDLY_MODIFIED_ERROR = "File has been unexpectedly modified. Read it again before attempting to write it.";

const inputSchema = z.object({
  file_path: z.string().describe("The absolute path to the file to write"),
  content: z.string().describe("The content to write to the file")
}).strict();

const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string())
});

const outputSchema = z.object({
  type: z.enum(["create", "update"]),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(hunkSchema),
  originalFile: z.string().nullable()
});

export function registerFsWriteTool(server: McpServer, state: SessionState): void {
  server.registerTool(
    FILE_WRITE_TOOL_NAME,
    {
      title: "Write File",
      description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you must use fs_read first to read the file's contents.
- Prefer fs_edit for modifying existing files and fs_write for creation or complete rewrites.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ file_path, content }) => {
      try {
        const validationError = await validateWriteInput(file_path, state);
        if (validationError) {
          return errorResult(validationError);
        }

        const fullFilePath = expandPath(file_path);
        await mkdir(dirname(fullFilePath), { recursive: true });

        let meta: ReturnType<typeof readFileSyncWithMetadata> | null;
        try {
          meta = readFileSyncWithMetadata(fullFilePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            meta = null;
          } else {
            throw error;
          }
        }

        if (meta !== null) {
          const lastWriteTime = getFileModificationTime(fullFilePath);
          const lastRead = state.readFileState.get(fullFilePath);
          if (!lastRead || lastWriteTime > lastRead.timestamp) {
            throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
          }
        }

        writeTextContent(fullFilePath, content, meta?.encoding ?? "utf8", "LF");
        state.readFileState.set(fullFilePath, {
          content,
          timestamp: getFileModificationTime(fullFilePath)
        });

        if (meta !== null) {
          const patch = getPatchForDisplay({
            filePath: file_path,
            fileContents: meta.content,
            edits: [
              {
                old_string: meta.content,
                new_string: content,
                replace_all: false
              }
            ]
          });
          const data = {
            type: "update" as const,
            filePath: file_path,
            content,
            structuredPatch: patch,
            originalFile: meta.content
          };
          return {
            content: [{ type: "text", text: `The file ${file_path} has been updated successfully.` }],
            structuredContent: data
          };
        }

        const data = {
          type: "create" as const,
          filePath: file_path,
          content,
          structuredPatch: [],
          originalFile: null
        };
        return {
          content: [{ type: "text", text: `File created successfully at: ${file_path}` }],
          structuredContent: data
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );
}

async function validateWriteInput(filePath: string, state: SessionState): Promise<string | null> {
  const fullFilePath = expandPath(filePath);
  try {
    const fileStat = await stat(fullFilePath);
    const readTimestamp = state.readFileState.get(fullFilePath);
    if (!readTimestamp || readTimestamp.isPartialView) {
      return "File has not been read yet. Read it first before writing to it.";
    }
    const lastWriteTime = Math.floor(fileStat.mtimeMs);
    if (lastWriteTime > readTimestamp.timestamp) {
      return "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return null;
}

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}
