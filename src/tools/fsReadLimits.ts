// Limits are intentionally generous: the MCP server's job is to deliver bytes,
// not to second-guess what fits the model's context. The model can paginate
// via offset/limit when it wants smaller chunks. Both knobs are overridable
// via env vars for callers that need a tighter cap.
export const DEFAULT_MAX_OUTPUT_TOKENS = 250_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type FileReadingLimits = {
  maxTokens: number;
  maxSizeBytes: number;
};

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function getDefaultFileReadingLimits(): FileReadingLimits {
  return {
    maxSizeBytes:
      parsePositiveInt(process.env.FS_TOOLS_MCP_FILE_READ_MAX_BYTES) ??
      DEFAULT_MAX_OUTPUT_BYTES,
    maxTokens:
      parsePositiveInt(process.env.FS_TOOLS_MCP_FILE_READ_MAX_OUTPUT_TOKENS) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
  };
}
