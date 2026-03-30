/**
 * Logging helper. All output goes to stderr so stdout stays clean for MCP stdio transport.
 */

export function log(message: string): void {
  console.error(`[eigenflux-mcp] ${message}`);
}
