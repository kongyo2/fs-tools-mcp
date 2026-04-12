import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdir, readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from "../constants/apiLimits.js";
import { hasBinaryExtension } from "../constants/files.js";
import type { SessionState } from "../state.js";
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from "../utils/file.js";
import { safeStat } from "../utils/fsResult.js";
import { isENOENT } from "../utils/errors.js";
import { formatFileSize } from "../utils/format.js";
import { readNotebook } from "../utils/notebook.js";
import { extractPDFPages, getPDFPageCount, readPDF } from "../utils/pdf.js";
import { isPDFExtension, parsePDFPageRange } from "../utils/pdfUtils.js";
import { expandPath } from "../utils/path.js";
import { readFileInRange } from "../utils/readFileInRange.js";
import { semanticNumber } from "../utils/semanticNumber.js";
import { getDefaultFileReadingLimits } from "./fsReadLimits.js";
import { readImageWithTokenBudget } from "./sharedRead.js";

const FILE_READ_TOOL_NAME = "fs_read";
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
      "The number of lines to read. Only provide if the file is too large to read at once.",
    ),
    pages: z
      .string()
      .optional()
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
  })
  .strict();

// Detailed discriminated union for TypeScript type inference only.
// NOT passed to MCP SDK's registerTool because the SDK's normalizeObjectSchema
// cannot handle discriminatedUnion (returns undefined), which causes a crash
// in safeParseAsync when isZ4Schema accesses undefined._zod.
const readOutputUnion = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    file: z.object({
      filePath: z.string(),
      content: z.string(),
      numLines: z.number(),
      startLine: z.number(),
      totalLines: z.number(),
    }),
  }),
  z.object({
    type: z.literal("image"),
    file: z.object({
      base64: z.string(),
      type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
      originalSize: z.number(),
      dimensions: z
        .object({
          originalWidth: z.number().optional(),
          originalHeight: z.number().optional(),
          displayWidth: z.number().optional(),
          displayHeight: z.number().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("notebook"),
    file: z.object({
      filePath: z.string(),
      cells: z.array(z.any()),
    }),
  }),
  z.object({
    type: z.literal("pdf"),
    file: z.object({
      filePath: z.string(),
      base64: z.string(),
      originalSize: z.number(),
    }),
  }),
  z.object({
    type: z.literal("parts"),
    file: z.object({
      filePath: z.string(),
      originalSize: z.number(),
      count: z.number(),
      outputDir: z.string(),
    }),
  }),
  z.object({
    type: z.literal("file_unchanged"),
    file: z.object({
      filePath: z.string(),
    }),
  }),
]);

type ReadOutput = z.infer<typeof readOutputUnion>;

// Flat object schema compatible with MCP SDK's normalizeObjectSchema.
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
- By default, it reads from the beginning of the file.
- You can optionally specify offset and limit for long files.
- This tool can read images, Jupyter notebooks, and PDF files.
- For PDFs over ${PDF_AT_MENTION_INLINE_THRESHOLD} pages, you must provide the pages parameter.`,
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

        const ext = fullFilePath.split(".").at(-1)?.toLowerCase() ?? "";
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
          !existingState.isPartialView &&
          existingState.offset !== undefined &&
          existingState.offset === offset &&
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
          // On stat failure (e.g. file deleted), fall through to full read.
        }

        const data = await callReadTool(
          file_path,
          fullFilePath,
          offset,
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
                offset,
                limit,
                pages,
                state,
                fullFilePath,
              );
              return await mapReadOutput(data);
            } catch (retryError) {
              if (!isENOENT(retryError)) {
                return errorResult(
                  retryError instanceof Error
                    ? retryError.message
                    : String(retryError),
                );
              }
            }
          }
          const cwdSuggestion = await suggestPathUnderCwd(fullFilePath);
          const similarFilename = findSimilarFile(fullFilePath);
          let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`;
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`;
          } else if (similarFilename) {
            message += ` Did you mean ${similarFilename}?`;
          }
          return errorResult(message);
        }
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
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
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
  state: SessionState,
  readStatePathOverride?: string,
): Promise<ReadOutput> {
  const readStatePath = readStatePathOverride ?? resolvedPath;
  const ext = resolvedPath.split(".").at(-1)?.toLowerCase() ?? "";
  const limits = getDefaultFileReadingLimits();

  if (ext === "ipynb") {
    const cells = await readNotebook(resolvedPath);
    const serialized = JSON.stringify(cells);
    validateContentTokens(serialized, limits.maxTokens);
    state.readFileState.set(readStatePath, {
      content: serialized,
      timestamp: await getFileModificationTimeAsync(resolvedPath),
      offset,
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
    if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
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

  const lineOffset = offset === 0 ? 0 : offset - 1;
  const range = await readFileInRange(
    resolvedPath,
    lineOffset,
    limit,
    limit === undefined ? limits.maxSizeBytes : undefined,
  );
  validateContentTokens(range.content, limits.maxTokens);
  state.readFileState.set(readStatePath, {
    content: range.content,
    timestamp: Math.floor(range.mtimeMs),
    offset,
    limit,
  });
  return {
    type: "text",
    file: {
      filePath: requestedPath,
      content: range.content,
      numLines: range.lineCount,
      startLine: offset,
      totalLines: range.totalLines,
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

async function mapReadOutput(
  data: ReadOutput,
): Promise<{ content: any[]; structuredContent: ReadOutput }> {
  switch (data.type) {
    case "text": {
      const text = data.file.content
        ? addLineNumbers({
            content: data.file.content,
            startLine: data.file.startLine,
          })
        : data.file.totalLines === 0
          ? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
          : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} lines.</system-reminder>`;
      return {
        content: [{ type: "text", text }],
        structuredContent: data,
      };
    }
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
      const blocks: any[] = [];
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
      const imageBlocks = await Promise.all(
        imageFiles.map(async (file) => {
          const imageBuffer = await readFileAsync(
            join(data.file.outputDir, file),
          );
          return {
            type: "image",
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

function errorResult(message: string): { content: any[]; isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
