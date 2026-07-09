import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname } from "node:path";
import { z } from "zod/v4";
import { getPatchForDisplay } from "../utils/diff.js";
import { writeTextContent } from "../utils/file.js";
import {
  readFileSyncWithMetadata,
  sniffFileTextMetadata,
  type LineEndingType,
} from "../utils/fileRead.js";
import { safeMkdir, safeStat } from "../utils/fsResult.js";
import { expandPath } from "../utils/path.js";
import { errorResult, unknownErrorResult } from "./toolResult.js";

const FILE_WRITE_TOOL_NAME = "fs_write";
// Skip diff generation against existing content above this size; the write
// itself still succeeds.
const MAX_DIFF_FILE_SIZE = 16 * 1024 * 1024;

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

export function registerFsWriteTool(server: McpServer): void {
  server.registerTool(
    FILE_WRITE_TOOL_NAME,
    {
      title: "Write File",
      description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- Prefer fs_edit for modifying existing files and fs_write for creation or complete rewrites.`,
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
        const statResult = await safeStat(fullFilePath);
        let existingSize: number | null = null;
        if (statResult.isOk()) {
          if (statResult.value.isDirectory()) {
            return errorResult(`Path is a directory: ${file_path}`);
          }
          existingSize = statResult.value.size;
        } else if (statResult.error.code !== "ENOENT") {
          return errorResult(`Cannot access path: ${statResult.error.message}`);
        }
        const fileExists = existingSize !== null;

        const mkdirResult = await safeMkdir(dirname(fullFilePath));
        if (mkdirResult.isErr()) {
          return errorResult(
            `Failed to create directory: ${mkdirResult.error.message}`,
          );
        }

        // Preserve the existing file's encoding and line endings; the sniff
        // reads only the head of the file, so it works for any size. The full
        // content is read separately - and only for reasonably sized files -
        // to produce the diff. If the existing file cannot be read, still
        // overwrite it, just without a diff.
        let encoding: BufferEncoding = "utf8";
        let lineEndings: LineEndingType = "LF";
        let meta: ReturnType<typeof readFileSyncWithMetadata> | null = null;
        if (existingSize !== null) {
          try {
            const sniffed = sniffFileTextMetadata(fullFilePath);
            encoding = sniffed.encoding;
            lineEndings = sniffed.lineEndings;
          } catch {
            // Keep the utf8/LF defaults.
          }
          if (existingSize <= MAX_DIFF_FILE_SIZE) {
            try {
              meta = readFileSyncWithMetadata(fullFilePath);
            } catch {
              meta = null;
            }
          }
        }

        writeTextContent(fullFilePath, content, encoding, lineEndings);

        if (fileExists) {
          const patch = meta
            ? getPatchForDisplay({
                filePath: file_path,
                fileContents: meta.content,
                edits: [
                  {
                    old_string: meta.content,
                    new_string: content,
                    replace_all: false,
                  },
                ],
              })
            : [];
          const data = {
            type: "update" as const,
            filePath: file_path,
            content,
            structuredPatch: patch,
            originalFile: meta?.content ?? null,
          };
          return {
            content: [
              {
                type: "text" as const,
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
              type: "text" as const,
              text: `File created successfully at: ${file_path}`,
            },
          ],
          structuredContent: data,
        };
      } catch (error) {
        return unknownErrorResult(error);
      }
    },
  );
}
