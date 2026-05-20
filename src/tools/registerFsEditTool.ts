import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname } from "node:path";
import { Result, ok, err } from "neverthrow";
import { z } from "zod/v4";
import {
  getPatchForEdit,
  findActualString,
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
import {
  safeStat,
  safeMkdir,
  type FsError,
  toFsError,
} from "../utils/fsResult.js";
import type { DetectedEncoding } from "../utils/encoding.js";
import { expandPath } from "../utils/path.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";
import type { SessionState } from "../state.js";

const FILE_EDIT_TOOL_NAME = "fs_edit";

const inputSchema = z
  .object({
    file_path: z.string().describe("The absolute path to the file to modify"),
    old_string: z.string().describe("The text to replace"),
    new_string: z.string().describe("The text to replace it with"),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe("Replace all occurrences of old_string (default false)"),
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
  oldString: z.string(),
  newString: z.string(),
  originalFile: z.string(),
  structuredPatch: z.array(hunkSchema),
  userModified: z.boolean(),
  replaceAll: z.boolean(),
});

export function registerFsEditTool(
  server: McpServer,
  state: SessionState,
): void {
  server.registerTool(
    FILE_EDIT_TOOL_NAME,
    {
      title: "Edit File",
      description: `Performs exact string replacements in files.

Usage:
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if old_string is not unique in the file. Provide more surrounding context to make it unique, or use replace_all to change every instance.
- Use replace_all to rename a variable across the file.
- For creating a new file, pass an empty old_string and the desired content as new_string.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file_path, old_string, new_string, replace_all = false }) => {
      try {
        const validationError = await validateEditInput(
          file_path,
          old_string,
          new_string,
          replace_all,
        );
        if (validationError) {
          return errorResult(validationError);
        }

        const absoluteFilePath = expandPath(file_path);
        const mkdirResult = await safeMkdir(dirname(absoluteFilePath));
        if (mkdirResult.isErr()) {
          return errorResult(
            `Failed to create directory: ${mkdirResult.error.message}`,
          );
        }

        const currentMetaResult = readFileForEdit(absoluteFilePath);
        if (
          currentMetaResult.isErr() &&
          currentMetaResult.error.code !== "ENOENT"
        ) {
          return errorResult(
            `Cannot read file for editing: ${currentMetaResult.error.message}`,
          );
        }
        const currentMeta: FileEditMeta = currentMetaResult.isOk()
          ? currentMetaResult.value
          : { content: "", encoding: "utf8", lineEndings: "LF" };

        const actualOldString =
          findActualString(currentMeta.content, old_string) ?? old_string;
        const actualNewString = preserveQuoteStyle(
          old_string,
          actualOldString,
          new_string,
        );
        const { patch, updatedFile } = getPatchForEdit({
          filePath: absoluteFilePath,
          fileContents: currentMeta.content,
          oldString: actualOldString,
          newString: actualNewString,
          replaceAll: replace_all,
        });

        writeTextContent(
          absoluteFilePath,
          updatedFile,
          currentMeta.encoding,
          currentMeta.lineEndings,
          currentMeta.detected,
        );

        // Record the post-edit content and mtime. offset/limit are left
        // undefined so the fs_read dedup gate skips this entry and the next
        // fs_read returns the new content rather than a stale stub.
        state.readFileState.set(absoluteFilePath, {
          content: updatedFile,
          timestamp: getFileModificationTime(absoluteFilePath),
          offset: undefined,
          limit: undefined,
        });

        const data = {
          filePath: file_path,
          oldString: actualOldString,
          newString: new_string,
          originalFile: currentMeta.content,
          structuredPatch: patch,
          userModified: false,
          replaceAll: replace_all,
        };

        return {
          content: [
            {
              type: "text",
              text: replace_all
                ? `The file ${file_path} has been updated. All occurrences were successfully replaced.`
                : `The file ${file_path} has been updated successfully.`,
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

async function validateEditInput(
  filePath: string,
  oldString: string,
  newString: string,
  _replaceAll: boolean,
): Promise<string | null> {
  const fullFilePath = expandPath(filePath);

  if (oldString === newString) {
    return "No changes to make: old_string and new_string are exactly the same.";
  }

  const statResult = await safeStat(fullFilePath);
  if (statResult.isErr() && statResult.error.code !== "ENOENT") {
    return `Cannot access file: ${statResult.error.message}`;
  }

  const readResult = readFileForEdit(fullFilePath);
  const fileContent = readResult.isOk() ? readResult.value.content : null;
  if (readResult.isErr() && readResult.error.code !== "ENOENT") {
    return `Cannot read file: ${readResult.error.message}`;
  }

  if (fileContent === null) {
    if (oldString === "") {
      return null;
    }
    const cwdSuggestion = await suggestPathUnderCwd(fullFilePath);
    const similarFilename = findSimilarFile(fullFilePath);
    let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`;
    if (cwdSuggestion) {
      message += ` Did you mean ${cwdSuggestion}?`;
    } else if (similarFilename) {
      message += ` Did you mean ${similarFilename}?`;
    }
    return message;
  }

  if (oldString === "") {
    // Empty old_string + existing content == full-content rewrite. Treat as
    // legitimate, since the caller can already do this via fs_write; making
    // fs_edit handle it too saves a round-trip.
    return null;
  }

  if (fullFilePath.endsWith(".ipynb")) {
    return "File is a Jupyter Notebook. Use fs_notebook_edit instead, or fs_write for a full rewrite.";
  }

  const actualOldString = findActualString(fileContent, oldString);
  if (!actualOldString) {
    return `String to replace not found in file.\nString: ${oldString}`;
  }

  const matches = fileContent.split(actualOldString).length - 1;
  if (matches > 1 && !_replaceAll) {
    return `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
  }

  return null;
}

type FileEditMeta = {
  content: string;
  encoding: BufferEncoding;
  lineEndings: "CRLF" | "LF";
  detected?: DetectedEncoding;
};

function readFileForEdit(
  absoluteFilePath: string,
): Result<FileEditMeta, FsError> {
  try {
    const meta = readFileSyncWithMetadata(absoluteFilePath);
    return ok({
      content: meta.content,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
      detected: meta.detected,
    });
  } catch (error) {
    return err(toFsError(error));
  }
}

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
