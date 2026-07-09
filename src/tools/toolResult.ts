import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function unknownErrorResult(error: unknown): CallToolResult {
  return errorResult(error instanceof Error ? error.message : String(error));
}
