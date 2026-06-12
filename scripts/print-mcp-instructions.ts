// Dev helper: print the MCP server instructions exactly as clients receive them.
import "../src/env.js";
import { createMcpServer } from "../src/mcp.js";

const server = createMcpServer() as unknown as { server: { _options?: { instructions?: string } } };
console.log(server.server._options?.instructions ?? "(no instructions)");
