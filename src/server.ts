import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSessionState } from "./state.js";
import { registerFsEditTool } from "./tools/registerFsEditTool.js";
import { registerFsGlobTool } from "./tools/registerFsGlobTool.js";
import { registerFsGrepTool } from "./tools/registerFsGrepTool.js";
import { registerFsMultiEditTool } from "./tools/registerFsMultiEditTool.js";
import { registerFsNotebookEditTool } from "./tools/registerFsNotebookEditTool.js";
import { registerFsReadTool } from "./tools/registerFsReadTool.js";
import { registerFsWriteTool } from "./tools/registerFsWriteTool.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "fs-tools-mcp-server",
    version: "0.2.0",
  });
  const state = createSessionState();
  registerFsReadTool(server, state);
  registerFsEditTool(server, state);
  registerFsMultiEditTool(server, state);
  registerFsWriteTool(server, state);
  registerFsGlobTool(server);
  registerFsGrepTool(server);
  registerFsNotebookEditTool(server, state);
  return server;
}
