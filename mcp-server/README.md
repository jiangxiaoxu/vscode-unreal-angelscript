# Angelscript MCP Server

An MCP (Model Context Protocol) server that exposes the Angelscript API search functionality, enabling Codex and other MCP-compatible clients to search the Angelscript API database.

## Architecture

The MCP server is now **integrated into the VS Code extension** and shares the LanguageClient with the extension. This means:

1. The MCP server is started by the VS Code extension when activated
2. It reuses the same LanguageClient connection to the language server
3. The type database is shared with the extension

## Features

- **angelscript_searchApi**: Search the Angelscript API database for symbols and documentation

## Usage

### Method 1: Extension-Integrated (Recommended)

The MCP server is automatically available when the VS Code extension is activated. Use VS Code commands to control it:

- `angelscript.startMcpServer` - Start the MCP server
- `angelscript.stopMcpServer` - Stop the MCP server

### Method 2: Standalone Mode (Legacy)

For standalone usage without VS Code, you can still run the standalone server:

```bash
cd mcp-server
npm install
npm run build
node out/index.js
```

## Usage with Codex

Add the following to your `~/.codex/config.toml`:

```toml
[mcp_servers.angelscript]
command = "node"
args = ["/path/to/vscode-unreal-angelscript/mcp-server/out/index.js"]
```

Replace `/path/to/vscode-unreal-angelscript` with the actual path to this repository.

## Tool: angelscript_searchApi

Search the Angelscript API database for symbols and documentation.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search query text for Angelscript API symbols |
| `limit` | number | No | 500 | Maximum number of results to return (1-1000) |
| `includeDetails` | boolean | No | true | Include documentation details for top matches |

### Example

```json
{
  "query": "GetActor",
  "limit": 100,
  "includeDetails": true
}
```

### Response

Returns a JSON object with:

```json
{
  "query": "GetActor",
  "total": 150,
  "returned": 100,
  "truncated": true,
  "items": [
    {
      "label": "AActor.GetActorLocation()",
      "type": "function",
      "data": ["method", "AActor", "GetActorLocation", 123],
      "details": "```angelscript_snippet\nFVector AActor.GetActorLocation()\n```\n..."
    }
  ]
}
```

## Requirements

- Node.js >= 18.0.0
- VS Code with the Unreal Angelscript extension installed (for extension-integrated mode)
- The language server must be running and connected to Unreal Engine

## License

MIT
