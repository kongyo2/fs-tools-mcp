import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname } from "node:path";
import { z } from "zod/v4";
import {
  countOccurrences,
  getPatchForEdit,
  findActualString,
  preserveQuoteStyle,
} from "./fsEditUtils.js";
import { fileNotFoundMessage, writeTextContent } from "../utils/file.js";
import { readFileSyncWithMetadata } from "../utils/fileRead.js";
import {
  safeStat,
  safeMkdir,
  type FsError,
  toFsError,
} from "../utils/fsResult.js";
import { Result, ok, err } from "neverthrow";
import { expandPath } from "../utils/path.js";
import { semanticBoolean } from "../utils/semanticBoolean.js";
import { errorResult, unknownErrorResult } from "./toolResult.js";

const FILE_EDIT_TOOL_NAME = "fs_edit";
// Keep well below V8's maximum string length (~512 MB) so the file can be
// read into a single string safely.
const MAX_EDIT_FILE_SIZE = 256 * 1024 * 1024;

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

export function registerFsEditTool(server: McpServer): void {
  server.registerTool(
    FILE_EDIT_TOOL_NAME,
    {
      title: "Edit File",
      description:
        "Modify file contents in place using old_string/new_string replacement.",
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
        const absoluteFilePath = expandPath(file_path);
        const prepared = await prepareEdit(
          absoluteFilePath,
          old_string,
          new_string,
          replace_all,
        );
        if (!prepared.ok) {
          return errorResult(prepared.message);
        }
        const { meta, actualOldString } = prepared;

        const mkdirResult = await safeMkdir(dirname(absoluteFilePath));
        if (mkdirResult.isErr()) {
          return errorResult(
            `Failed to create directory: ${mkdirResult.error.message}`,
          );
        }

        const actualNewString = preserveQuoteStyle(
          old_string,
          actualOldString,
          new_string,
        );
        const { patch, updatedFile } = getPatchForEdit({
          filePath: absoluteFilePath,
          fileContents: meta.content,
          oldString: actualOldString,
          newString: actualNewString,
          replaceAll: replace_all,
        });

        writeTextContent(
          absoluteFilePath,
          updatedFile,
          meta.encoding,
          meta.lineEndings,
        );

        const data = {
          filePath: file_path,
          oldString: actualOldString,
          newString: actualNewString,
          originalFile: meta.content,
          structuredPatch: patch,
          userModified: false,
          replaceAll: replace_all,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: replace_all
                ? `The file ${file_path} has been updated. All occurrences were successfully replaced.`
                : `The file ${file_path} has been updated successfully.`,
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

type FileEditMeta = {
  content: string;
  encoding: BufferEncoding;
  lineEndings: "CRLF" | "LF";
};

type PreparedEdit =
  | { ok: true; meta: FileEditMeta; actualOldString: string }
  | { ok: false; message: string };

async function prepareEdit(
  fullFilePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<PreparedEdit> {
  if (oldString === newString) {
    return {
      ok: false,
      message:
        "No changes to make: old_string and new_string are exactly the same.",
    };
  }

  const statResult = await safeStat(fullFilePath);
  if (statResult.isOk()) {
    if (statResult.value.isDirectory()) {
      return { ok: false, message: `Path is a directory: ${fullFilePath}` };
    }
    if (statResult.value.size > MAX_EDIT_FILE_SIZE) {
      return {
        ok: false,
        message: `File is too large to edit (${statResult.value.size} bytes). Maximum editable file size is ${MAX_EDIT_FILE_SIZE} bytes.`,
      };
    }
  } else if (statResult.error.code !== "ENOENT") {
    return {
      ok: false,
      message: `Cannot access file: ${statResult.error.message}`,
    };
  }

  const readResult = readFileForEdit(fullFilePath);
  if (readResult.isErr()) {
    if (readResult.error.code !== "ENOENT") {
      return {
        ok: false,
        message: `Cannot read file: ${readResult.error.message}`,
      };
    }
    if (oldString === "") {
      // Creating a new file.
      return {
        ok: true,
        meta: { content: "", encoding: "utf8", lineEndings: "LF" },
        actualOldString: oldString,
      };
    }
    return { ok: false, message: await fileNotFoundMessage(fullFilePath) };
  }

  const meta = readResult.value;
  if (oldString === "") {
    if (meta.content.trim() !== "") {
      return {
        ok: false,
        message: "Cannot create new file - file already exists.",
      };
    }
    return { ok: true, meta, actualOldString: oldString };
  }

  if (fullFilePath.endsWith(".ipynb")) {
    return {
      ok: false,
      message:
        "File is a Jupyter Notebook. Use fs_read to inspect it and fs_write if you need a full rewrite.",
    };
  }

  const actualOldString = findActualString(meta.content, oldString);
  if (!actualOldString) {
    return {
      ok: false,
      message: `String to replace not found in file.\nString: ${oldString}`,
    };
  }

  const matches = countOccurrences(meta.content, actualOldString);
  if (matches > 1 && !replaceAll) {
    return {
      ok: false,
      message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
    };
  }

  return { ok: true, meta, actualOldString };
}

function readFileForEdit(
  absoluteFilePath: string,
): Result<FileEditMeta, FsError> {
  try {
    const meta = readFileSyncWithMetadata(absoluteFilePath);
    return ok({
      content: meta.content,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    });
  } catch (error) {
    return err(toFsError(error));
  }
}
