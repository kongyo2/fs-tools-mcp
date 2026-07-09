import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { readdir, readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  PDF_MAX_INLINE_PAGES,
  PDF_MAX_PAGES_PER_READ,
} from "../constants/apiLimits.js";
import { hasBinaryExtension } from "../constants/files.js";
import type { SessionState } from "../state.js";
import {
  addLineNumbers,
  fileNotFoundMessage,
  getFileModificationTimeAsync,
} from "../utils/file.js";
import { safeStat } from "../utils/fsResult.js";
import { isENOENT } from "../utils/errors.js";
import { formatFileSize } from "../utils/format.js";
import { readNotebook, type NotebookCellSource } from "../utils/notebook.js";
import { extractPDFPages, getPDFPageCount, readPDF } from "../utils/pdf.js";
import { isPDFExtension, parsePDFPageRange } from "../utils/pdfUtils.js";
import { expandPath, getLowercaseExtension } from "../utils/path.js";
import { readFileInRange } from "../utils/readFileInRange.js";
import { semanticNumber } from "../utils/semanticNumber.js";
import { getDefaultFileReadingLimits } from "./fsReadLimits.js";
import { readImageWithTokenBudget } from "./sharedRead.js";
import { errorResult, unknownErrorResult } from "./toolResult.js";

const FILE_READ_TOOL_NAME = "fs_read";
const DEFAULT_READ_LINE_LIMIT = 2000;
const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier fs_read tool_result in this conversation is still current; refer to that instead of re-reading.";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);
const THIN_SPACE = String.fromCharCode(8239);

const inputSchema = z
  .object({
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      "The line number to start reading from. Only provide if the file is too large to read at once.",
    ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      `The number of lines to read. Defaults to ${DEFAULT_READ_LINE_LIMIT}. Only provide if the file is too large to read at once.`,
    ),
    pages: z
      .string()
      .optional()
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
  })
  .strict();

type ReadOutput =
  | {
      type: "text";
      file: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
        truncated?: boolean;
      };
    }
  | {
      type: "image";
      file: {
        base64: string;
        type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        originalSize: number;
        dimensions?: {
          originalWidth?: number;
          originalHeight?: number;
          displayWidth?: number;
          displayHeight?: number;
        };
      };
    }
  | {
      type: "notebook";
      file: {
        filePath: string;
        cells: NotebookCellSource[];
      };
    }
  | {
      type: "pdf";
      file: {
        filePath: string;
        base64: string;
        originalSize: number;
      };
    }
  | {
      type: "parts";
      file: {
        filePath: string;
        originalSize: number;
        count: number;
        outputDir: string;
      };
    }
  | {
      type: "file_unchanged";
      file: {
        filePath: string;
      };
    };

// Flat object schema: the MCP SDK's schema normalization cannot handle a
// zod discriminated union (it returns undefined and later crashes), so the
// detailed shape lives in the ReadOutput type above instead.
const outputSchema = z.object({
  type: z.enum(["text", "image", "notebook", "pdf", "parts", "file_unchanged"]),
  file: z.any(),
});

export function registerFsReadTool(
  server: McpServer,
  state: SessionState,
): void {
  server.registerTool(
    FILE_READ_TOOL_NAME,
    {
      title: "Read File",
      description: `Reads a file from the local filesystem.

Usage:
- The file_path parameter must be an absolute path, not a relative path.
- By default, it reads up to ${DEFAULT_READ_LINE_LIMIT} lines from the beginning of the file.
- You can optionally specify offset and limit for long files.
- This tool can read images, Jupyter notebooks, and PDF files.
- For PDFs over ${PDF_MAX_INLINE_PAGES} pages, you must provide the pages parameter.`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file_path, offset = 1, limit, pages }) => {
      // Treat offset 0 and 1 identically as "start of file" so line numbers
      // in the output always match the 1-indexed offset parameter.
      const startLine = Math.max(offset, 1);
      try {
        if (pages !== undefined) {
          const parsed = parsePDFPageRange(pages);
          if (!parsed) {
            return errorResult(
              `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
            );
          }
          const rangeSize =
            parsed.lastPage === Number.POSITIVE_INFINITY
              ? PDF_MAX_PAGES_PER_READ + 1
              : parsed.lastPage - parsed.firstPage + 1;
          if (rangeSize > PDF_MAX_PAGES_PER_READ) {
            return errorResult(
              `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
            );
          }
        }

        const fullFilePath = expandPath(file_path);
        if (isBlockedDevicePath(fullFilePath)) {
          return errorResult(
            `Cannot read '${file_path}': this device file would block or produce infinite output.`,
          );
        }

        const ext = getLowercaseExtension(fullFilePath);
        if (pages !== undefined && !isPDFExtension(ext)) {
          return errorResult(
            `The pages parameter is only supported for PDF files, but the file has extension ".${ext}".`,
          );
        }
        if (
          hasBinaryExtension(fullFilePath) &&
          !isPDFExtension(ext) &&
          !IMAGE_EXTENSIONS.has(ext)
        ) {
          return errorResult(
            `This tool cannot read binary files. The file appears to be a binary .${ext} file. Please use appropriate tools for binary file analysis.`,
          );
        }

        const existingState = state.readFileState.get(fullFilePath);
        if (
          existingState &&
          existingState.offset === startLine &&
          existingState.limit === limit
        ) {
          const mtimeResult = await safeStat(fullFilePath);
          if (mtimeResult.isOk()) {
            const mtimeMs = Math.floor(mtimeResult.value.mtimeMs);
            if (mtimeMs === existingState.timestamp) {
              const data: ReadOutput = {
                type: "file_unchanged",
                file: {
                  filePath: file_path,
                },
              };
              return {
                content: [{ type: "text", text: FILE_UNCHANGED_STUB }],
                structuredContent: data,
              };
            }
          }
          // On stat failure (e.g. file deleted), fall through to a full read.
        }

        const data = await callReadTool(
          file_path,
          fullFilePath,
          startLine,
          limit,
          pages,
          state,
        );
        return await mapReadOutput(data);
      } catch (error) {
        if (isENOENT(error)) {
          const fullFilePath = expandPath(file_path);
          const alternatePath = getAlternateScreenshotPath(fullFilePath);
          if (alternatePath) {
            try {
              const data = await callReadTool(
                file_path,
                alternatePath,
                startLine,
                limit,
                pages,
                state,
                fullFilePath,
              );
              return await mapReadOutput(data);
            } catch (retryError) {
              if (!isENOENT(retryError)) {
                return unknownErrorResult(retryError);
              }
            }
          }
          return errorResult(await fileNotFoundMessage(fullFilePath));
        }
        return unknownErrorResult(error);
      }
    },
  );
}

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) {
    return true;
  }
  return (
    filePath.startsWith("/proc/") &&
    (filePath.endsWith("/fd/0") ||
      filePath.endsWith("/fd/1") ||
      filePath.endsWith("/fd/2"))
  );
}

function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = filePath.split(/[\\/]/).at(-1);
  if (!filename) {
    return undefined;
  }
  const match = filename.match(/^(.+)([ \u202F])(AM|PM)(\.png)$/);
  if (!match) {
    return undefined;
  }
  const currentSpace = match[2];
  const alternateSpace = currentSpace === " " ? THIN_SPACE : " ";
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  );
}

async function callReadTool(
  requestedPath: string,
  resolvedPath: string,
  startLine: number,
  limit: number | undefined,
  pages: string | undefined,
  state: SessionState,
  readStatePathOverride?: string,
): Promise<ReadOutput> {
  const readStatePath = readStatePathOverride ?? resolvedPath;
  const ext = getLowercaseExtension(resolvedPath);
  const limits = getDefaultFileReadingLimits();

  if (ext === "ipynb") {
    const cells = await readNotebook(resolvedPath);
    validateContentTokens(JSON.stringify(cells), limits.maxTokens);
    state.readFileState.set(readStatePath, {
      timestamp: await getFileModificationTimeAsync(resolvedPath),
      offset: startLine,
      limit,
    });
    return {
      type: "notebook",
      file: {
        filePath: requestedPath,
        cells,
      },
    };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return await readImageWithTokenBudget(resolvedPath, limits.maxTokens);
  }

  if (isPDFExtension(ext)) {
    if (pages) {
      const parsedRange = parsePDFPageRange(pages);
      const extracted = await extractPDFPages(
        resolvedPath,
        parsedRange ?? undefined,
      );
      if (!extracted.success) {
        throw new Error(
          `PDF extraction failed (${extracted.error.reason}): ${extracted.error.message}`,
        );
      }
      return extracted.data;
    }
    const pageCount = await getPDFPageCount(resolvedPath);
    if (pageCount !== null && pageCount > PDF_MAX_INLINE_PAGES) {
      throw new Error(
        `This PDF has ${pageCount} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      );
    }
    const pdf = await readPDF(resolvedPath);
    if (!pdf.success) {
      throw new Error(
        `PDF read failed (${pdf.error.reason}): ${pdf.error.message}`,
      );
    }
    return pdf.data;
  }

  // Cap the byte budget so the returned content always fits the token budget
  // (4 bytes/token estimate); overly long content is truncated with a notice
  // instead of failing the whole read.
  const byteBudget = Math.min(limits.maxSizeBytes, limits.maxTokens * 4);
  const range = await readFileInRange(
    resolvedPath,
    startLine - 1,
    limit ?? DEFAULT_READ_LINE_LIMIT,
    byteBudget,
    undefined,
    { truncateOnByteLimit: true },
  );
  validateContentTokens(range.content, limits.maxTokens);
  state.readFileState.set(readStatePath, {
    timestamp: Math.floor(range.mtimeMs),
    offset: startLine,
    limit,
  });
  return {
    type: "text",
    file: {
      filePath: requestedPath,
      content: range.content,
      numLines: range.lineCount,
      startLine,
      totalLines: range.totalLines,
      ...(range.truncatedByBytes ? { truncated: true } : {}),
    },
  };
}

function validateContentTokens(content: string, maxTokens: number): void {
  const estimatedTokens = Math.ceil(content.length / 4);
  if (estimatedTokens > maxTokens) {
    throw new Error(
      `File content (${estimatedTokens} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    );
  }
}

function renderTextRead(file: {
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
  truncated?: boolean;
}): string {
  if (file.content) {
    const text = addLineNumbers({
      content: file.content,
      startLine: file.startLine,
    });
    if (!file.truncated) {
      return text;
    }
    const lastLine = file.startLine + file.numLines - 1;
    return `${text}\n\n<system-reminder>Output truncated at the byte limit: showing lines ${file.startLine}-${lastLine} of ${file.totalLines} total lines. Use offset and limit parameters to read further portions of the file.</system-reminder>`;
  }
  if (file.truncated) {
    return `<system-reminder>Warning: the first requested line is longer than the output byte limit and could not be returned. Search within the file instead of reading it directly.</system-reminder>`;
  }
  if (file.totalLines === 0) {
    return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
  }
  return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${file.startLine}). The file has ${file.totalLines} lines.</system-reminder>`;
}

async function mapReadOutput(data: ReadOutput): Promise<CallToolResult> {
  switch (data.type) {
    case "text":
      return {
        content: [{ type: "text", text: renderTextRead(data.file) }],
        structuredContent: data,
      };
    case "image":
      return {
        content: [
          {
            type: "image",
            data: data.file.base64,
            mimeType: data.file.type,
          },
          {
            type: "text",
            text: `Read image (${formatFileSize(data.file.originalSize)})`,
          },
        ],
        structuredContent: data,
      };
    case "notebook": {
      const blocks: ContentBlock[] = [];
      for (const cell of data.file.cells) {
        const metadata: string[] = [];
        if (cell.cellType !== "code") {
          metadata.push(`<cell_type>${cell.cellType}</cell_type>`);
        }
        if (
          cell.language &&
          cell.language !== "python" &&
          cell.cellType === "code"
        ) {
          metadata.push(`<language>${cell.language}</language>`);
        }
        blocks.push({
          type: "text",
          text: `<cell id="${cell.cell_id}">${metadata.join("")}${cell.source}</cell>`,
        });
        for (const output of cell.outputs ?? []) {
          if (output.text) {
            blocks.push({ type: "text", text: `\n${output.text}` });
          }
          if (output.image) {
            blocks.push({
              type: "image",
              data: output.image.image_data,
              mimeType: output.image.media_type,
            });
          }
        }
      }
      return {
        content: blocks,
        structuredContent: data,
      };
    }
    case "pdf":
      return {
        content: [
          {
            type: "text",
            text: `PDF file read: ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
          },
        ],
        structuredContent: data,
      };
    case "parts": {
      const imageFiles = (await readdir(data.file.outputDir))
        .filter((file) => file.endsWith(".jpg"))
        .sort();
      const imageBlocks: ContentBlock[] = await Promise.all(
        imageFiles.map(async (file) => {
          const imageBuffer = await readFileAsync(
            join(data.file.outputDir, file),
          );
          return {
            type: "image" as const,
            data: imageBuffer.toString("base64"),
            mimeType: "image/jpeg",
          };
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: `PDF pages extracted: ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
          },
          ...imageBlocks,
        ],
        structuredContent: data,
      };
    }
    case "file_unchanged":
      return {
        content: [{ type: "text", text: FILE_UNCHANGED_STUB }],
        structuredContent: data,
      };
  }
}
