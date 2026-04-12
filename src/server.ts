import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSessionState } from "./state.js";
import { registerFsEditTool } from "./tools/registerFsEditTool.js";
import { registerFsGlobTool } from "./tools/registerFsGlobTool.js";
import { registerFsGrepTool } from "./tools/registerFsGrepTool.js";
import { registerFsReadTool } from "./tools/registerFsReadTool.js";
import { registerFsWriteTool } from "./tools/registerFsWriteTool.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "fs-tools-mcp-server",
    version: "0.1.0",
  });
  const state = createSessionState();
  registerFsReadTool(server, state);
  registerFsEditTool(server);
  registerFsWriteTool(server);
  registerFsGlobTool(server);
  registerFsGrepTool(server);
  return server;
}
