import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname } from "node:path";
import { z } from "zod/v4";
import {
  findActualString,
  getPatchForEdits,
  normalizeFileEditInput,
  preserveQuoteStyle,
} from "./fsEditUtils.js";
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from "../utils/file.js";
import { readFileSyncWithMetadata } from "../utils/fileRead.js";
import { safeStat, safeMkdir, toFsError } from "../utils/fsResult.js";
import { isENOENT } from "../utils/errors.js";
import { expandPath } from "../utils/path.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";
import type { SessionState } from "../state.js";

const FILE_MULTI_EDIT_TOOL_NAME = "fs_multi_edit";

const editSchema = z.object({
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The text to replace it with"),
  replace_all: semanticBoolean(z.boolean().default(false).optional()).describe(
    "Replace all occurrences of old_string (default false)",
  ),
});

const inputSchema = z
  .object({
    file_path: z.string().describe("The absolute path to the file to modify"),
    edits: z
      .array(editSchema)
      .min(1)
      .describe(
        "Sequential edits applied to the file in order. Each edit sees the result of all previous edits.",
      ),
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
  filePath: z.string(),
  edits: z.array(editSchema),
  originalFile: z.string(),
  structuredPatch: z.array(hunkSchema),
});

export function registerFsMultiEditTool(
  server: McpServer,
  state: SessionState,
): void {
  server.registerTool(
    FILE_MULTI_EDIT_TOOL_NAME,
    {
      title: "Multi Edit File",
      description: `Apply multiple sequential edits to a single file in one atomic call.

Usage:
- Each edit's old_string/new_string follows the same rules as fs_edit.
- Edits run in order; each subsequent edit sees the result of the previous ones.
- Setting replace_all on an edit replaces every occurrence.
- The whole operation is atomic: if any edit cannot be applied, no changes are written.
- Pass an empty old_string with file content as new_string to create a new file in the same call.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file_path, edits }) => {
      try {
        if (edits.length === 0) {
          return errorResult("At least one edit is required.");
        }
        for (const edit of edits) {
          if (edit.old_string === edit.new_string) {
            return errorResult(
              "No changes to make: old_string and new_string are exactly the same.",
            );
          }
        }

        const fullFilePath = expandPath(file_path);
        if (fullFilePath.endsWith(".ipynb")) {
          return errorResult(
            "File is a Jupyter Notebook. Use fs_notebook_edit instead.",
          );
        }

        const mkdirResult = await safeMkdir(dirname(fullFilePath));
        if (mkdirResult.isErr()) {
          return errorResult(
            `Failed to create directory: ${mkdirResult.error.message}`,
          );
        }

        let meta: ReturnType<typeof readFileSyncWithMetadata> | null = null;
        try {
          meta = readFileSyncWithMetadata(fullFilePath);
        } catch (error) {
          if (!isENOENT(error)) {
            return errorResult(`Cannot read file: ${toFsError(error).message}`);
          }
        }

        const fileContent = meta?.content ?? "";
        if (meta === null) {
          if (edits[0]?.old_string !== "") {
            const cwdSuggestion = await suggestPathUnderCwd(fullFilePath);
            const similar = findSimilarFile(fullFilePath);
            let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`;
            if (cwdSuggestion) {
              message += ` Did you mean ${cwdSuggestion}?`;
            } else if (similar) {
              message += ` Did you mean ${similar}?`;
            }
            return errorResult(message);
          }
        }

        const statResult = await safeStat(fullFilePath);
        if (statResult.isErr() && statResult.error.code !== "ENOENT") {
          return errorResult(`Cannot access file: ${statResult.error.message}`);
        }

        const normalized = normalizeFileEditInput({
          file_path: fullFilePath,
          edits: edits.map((edit) => ({
            old_string: edit.old_string,
            new_string: edit.new_string,
            replace_all: edit.replace_all ?? false,
          })),
        });
        const editsWithActual = normalized.edits.map((edit) => {
          if (edit.old_string === "") {
            return edit;
          }
          const actualOld =
            findActualString(fileContent, edit.old_string) ?? edit.old_string;
          const actualNew = preserveQuoteStyle(
            edit.old_string,
            actualOld,
            edit.new_string,
          );
          return {
            old_string: actualOld,
            new_string: actualNew,
            replace_all: edit.replace_all,
          };
        });

        const { patch, updatedFile } = getPatchForEdits({
          filePath: fullFilePath,
          fileContents: fileContent,
          edits: editsWithActual,
        });

        writeTextContent(
          fullFilePath,
          updatedFile,
          meta?.encoding ?? "utf8",
          meta?.lineEndings ?? "LF",
          meta?.detected,
        );

        state.readFileState.set(fullFilePath, {
          content: updatedFile,
          timestamp: getFileModificationTime(fullFilePath),
          offset: undefined,
          limit: undefined,
        });

        const data = {
          filePath: file_path,
          edits,
          originalFile: fileContent,
          structuredPatch: patch,
        };

        return {
          content: [
            {
              type: "text",
              text: `Applied ${edits.length} edit(s) to ${file_path}.`,
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
