import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod/v4";
import type { SessionState } from "../state.js";
import { getPatchForEdit, findActualString, preserveQuoteStyle } from "./fsEditUtils.js";
import { FILE_NOT_FOUND_CWD_NOTE, findSimilarFile, getFileModificationTime, suggestPathUnderCwd, writeTextContent } from "../utils/file.js";
import { readFileSyncWithMetadata } from "../utils/fileRead.js";
import { expandPath } from "../utils/path.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";

const FILE_EDIT_TOOL_NAME = "fs_edit";
const FILE_UNEXPECTEDLY_MODIFIED_ERROR = "File has been unexpectedly modified. Read it again before attempting to write it.";
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;

const inputSchema = z.object({
  file_path: z.string().describe("The absolute path to the file to modify"),
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The text to replace it with"),
  replace_all: semanticBoolean(z.boolean().default(false).optional()).describe("Replace all occurrences of old_string (default false)")
}).strict();

const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string())
});

const outputSchema = z.object({
  filePath: z.string(),
  oldString: z.string(),
  newString: z.string(),
  originalFile: z.string(),
  structuredPatch: z.array(hunkSchema),
  userModified: z.boolean(),
  replaceAll: z.boolean()
});

export function registerFsEditTool(server: McpServer, state: SessionState): void {
  server.registerTool(
    FILE_EDIT_TOOL_NAME,
    {
      title: "Edit File",
      description: "Modify file contents in place using old_string/new_string replacement.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ file_path, old_string, new_string, replace_all = false }) => {
      try {
        const validationError = await validateEditInput(file_path, old_string, new_string, replace_all, state);
        if (validationError) {
          return errorResult(validationError);
        }

        const absoluteFilePath = expandPath(file_path);
        await mkdir(dirname(absoluteFilePath), { recursive: true });

        const currentMeta = readFileForEdit(absoluteFilePath);
        if (currentMeta.fileExists) {
          const lastWriteTime = getFileModificationTime(absoluteFilePath);
          const lastRead = state.readFileState.get(absoluteFilePath);
          if (!lastRead || lastWriteTime > lastRead.timestamp) {
            throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
          }
        }

        const actualOldString = findActualString(currentMeta.content, old_string) ?? old_string;
        const actualNewString = preserveQuoteStyle(old_string, actualOldString, new_string);
        const { patch, updatedFile } = getPatchForEdit({
          filePath: absoluteFilePath,
          fileContents: currentMeta.content,
          oldString: actualOldString,
          newString: actualNewString,
          replaceAll: replace_all
        });

        writeTextContent(absoluteFilePath, updatedFile, currentMeta.encoding, currentMeta.lineEndings);
        state.readFileState.set(absoluteFilePath, {
          content: updatedFile,
          timestamp: getFileModificationTime(absoluteFilePath)
        });

        const data = {
          filePath: file_path,
          oldString: actualOldString,
          newString: new_string,
          originalFile: currentMeta.content,
          structuredPatch: patch,
          userModified: false,
          replaceAll: replace_all
        };

        return {
          content: [
            {
              type: "text",
              text: replace_all ? `The file ${file_path} has been updated. All occurrences were successfully replaced.` : `The file ${file_path} has been updated successfully.`
            }
          ],
          structuredContent: data
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    }
  );
}

async function validateEditInput(filePath: string, oldString: string, newString: string, replaceAll: boolean, state: SessionState): Promise<string | null> {
  const fullFilePath = expandPath(filePath);

  if (oldString === newString) {
    return "No changes to make: old_string and new_string are exactly the same.";
  }

  try {
    const metadata = await stat(fullFilePath);
    if (metadata.size > MAX_EDIT_FILE_SIZE) {
      return `File is too large to edit (${metadata.size} bytes). Maximum editable file size is ${MAX_EDIT_FILE_SIZE} bytes.`;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  let fileContent: string | null;
  try {
    fileContent = readFileForEdit(fullFilePath).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fileContent = null;
    } else {
      throw error;
    }
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
    return fileContent.trim() === "" ? null : "Cannot create new file - file already exists.";
  }

  if (fullFilePath.endsWith(".ipynb")) {
    return "File is a Jupyter Notebook. Use fs_read to inspect it and fs_write if you need a full rewrite.";
  }

  const lastRead = state.readFileState.get(fullFilePath);
  if (!lastRead || lastRead.isPartialView) {
    return `File has not been read yet. Read it first before writing to it.${isAbsolute(filePath) ? "" : " The provided path was not absolute."}`;
  }

  const lastWriteTime = getFileModificationTime(fullFilePath);
  if (lastWriteTime > lastRead.timestamp) {
    return "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
  }

  const actualOldString = findActualString(fileContent, oldString);
  if (!actualOldString) {
    return `String to replace not found in file.\nString: ${oldString}`;
  }

  const matches = fileContent.split(actualOldString).length - 1;
  if (matches > 1 && !replaceAll) {
    return `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
  }

  return null;
}

function readFileForEdit(absoluteFilePath: string): { content: string; fileExists: boolean; encoding: BufferEncoding; lineEndings: "CRLF" | "LF" } {
  try {
    const meta = readFileSyncWithMetadata(absoluteFilePath);
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        content: "",
        fileExists: false,
        encoding: "utf8",
        lineEndings: "LF"
      };
    }
    throw error;
  }
}

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}
