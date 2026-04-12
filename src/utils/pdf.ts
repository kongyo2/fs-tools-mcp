import { mkdir, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PDF_MAX_EXTRACT_SIZE,
  PDF_TARGET_RAW_SIZE,
} from "../constants/apiLimits.js";
import { errorMessage } from "./errors.js";
import { execFileNoThrow } from "./execFileNoThrow.js";
import { formatFileSize } from "./format.js";
import { getToolResultsDir } from "./toolResults.js";

export type PDFError = {
  reason:
    | "empty"
    | "too_large"
    | "password_protected"
    | "corrupted"
    | "unknown"
    | "unavailable";
  message: string;
};

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError };

export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: "pdf";
    file: { filePath: string; base64: string; originalSize: number };
  }>
> {
  try {
    const fileBuffer = await readFile(filePath);
    const originalSize = fileBuffer.length;
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: "empty", message: `PDF file is empty: ${filePath}` },
      };
    }
    if (originalSize > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: "too_large",
          message: `PDF file exceeds maximum allowed size of ${formatFileSize(PDF_TARGET_RAW_SIZE)}.`,
        },
      };
    }
    if (!fileBuffer.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
      return {
        success: false,
        error: {
          reason: "corrupted",
          message: `File is not a valid PDF (missing %PDF- header): ${filePath}`,
        },
      };
    }
    return {
      success: true,
      data: {
        type: "pdf",
        file: {
          filePath,
          base64: fileBuffer.toString("base64"),
          originalSize,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: { reason: "unknown", message: errorMessage(error) },
    };
  }
}

export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  const result = await execFileNoThrow("pdfinfo", [filePath], {
    timeout: 10_000,
  });
  if (result.code !== 0) {
    return null;
  }
  const match = /^Pages:\s+(\d+)/m.exec(result.stdout);
  if (!match) {
    return null;
  }
  const count = Number.parseInt(match[1], 10);
  return Number.isNaN(count) ? null : count;
}

let pdftoppmAvailable: boolean | undefined;

export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined;
}

export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) {
    return pdftoppmAvailable;
  }
  const result = await execFileNoThrow("pdftoppm", ["-v"], { timeout: 5000 });
  pdftoppmAvailable = result.code === 0 || result.stderr.length > 0;
  return pdftoppmAvailable;
}

export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<
  PDFResult<{
    type: "parts";
    file: {
      filePath: string;
      originalSize: number;
      count: number;
      outputDir: string;
    };
  }>
> {
  try {
    const fileBuffer = await readFile(filePath);
    const originalSize = fileBuffer.length;
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: "empty", message: `PDF file is empty: ${filePath}` },
      };
    }
    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: "too_large",
          message: `PDF file exceeds maximum allowed size for text extraction (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
        },
      };
    }
    if (!(await isPdftoppmAvailable())) {
      return {
        success: false,
        error: {
          reason: "unavailable",
          message:
            "pdftoppm is not installed. Install poppler-utils to enable PDF page rendering.",
        },
      };
    }

    const outputDir = join(getToolResultsDir(), `pdf-${randomUUID()}`);
    await mkdir(outputDir, { recursive: true });
    const prefix = join(outputDir, "page");
    const args = ["-jpeg", "-r", "100"];
    if (options?.firstPage) {
      args.push("-f", String(options.firstPage));
    }
    if (options?.lastPage && options.lastPage !== Number.POSITIVE_INFINITY) {
      args.push("-l", String(options.lastPage));
    }
    args.push(filePath, prefix);
    const result = await execFileNoThrow("pdftoppm", args, {
      timeout: 120_000,
    });
    if (result.code !== 0) {
      if (/password/i.test(result.stderr)) {
        return {
          success: false,
          error: {
            reason: "password_protected",
            message:
              "PDF is password-protected. Please provide an unprotected version.",
          },
        };
      }
      if (/damaged|corrupt|invalid/i.test(result.stderr)) {
        return {
          success: false,
          error: {
            reason: "corrupted",
            message: "PDF file is corrupted or invalid.",
          },
        };
      }
      return {
        success: false,
        error: {
          reason: "unknown",
          message: `pdftoppm failed: ${result.stderr}`,
        },
      };
    }
    const imageFiles = (await readdir(outputDir))
      .filter((entry) => entry.endsWith(".jpg"))
      .sort();
    if (imageFiles.length === 0) {
      return {
        success: false,
        error: {
          reason: "corrupted",
          message: "pdftoppm produced no output pages. The PDF may be invalid.",
        },
      };
    }
    return {
      success: true,
      data: {
        type: "parts",
        file: {
          filePath,
          originalSize,
          count: imageFiles.length,
          outputDir,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: { reason: "unknown", message: errorMessage(error) },
    };
  }
}
