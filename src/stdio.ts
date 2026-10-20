import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { configuredServer, logFailure } from './server.js';
try { const server=await configuredServer();await server.connect(new StdioServerTransport()); }
catch { logFailure();process.exitCode=1; }
