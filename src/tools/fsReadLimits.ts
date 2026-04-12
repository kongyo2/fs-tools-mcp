import { MAX_OUTPUT_SIZE } from "../utils/file.js";

export const DEFAULT_MAX_OUTPUT_TOKENS = 25_000;

export type FileReadingLimits = {
  maxTokens: number;
  maxSizeBytes: number;
  includeMaxSizeInPrompt?: boolean;
  targetedRangeNudge?: boolean;
};

export function getDefaultFileReadingLimits(): FileReadingLimits {
  const envMaxTokens = Number.parseInt(process.env.FS_TOOLS_MCP_FILE_READ_MAX_OUTPUT_TOKENS ?? "", 10);
  return {
    maxSizeBytes: MAX_OUTPUT_SIZE,
    maxTokens: Number.isFinite(envMaxTokens) && envMaxTokens > 0 ? envMaxTokens : DEFAULT_MAX_OUTPUT_TOKENS
  };
}
