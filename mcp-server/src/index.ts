#!/usr/bin/env node
/**
 * MCP Server for Angelscript API Search
 * 
 * This server exposes the same angelscript_searchApi tool functionality
 * available in the VS Code extension, enabling Codex and other MCP-compatible
 * clients to search the Angelscript API database.
 * 
 * Usage with Codex:
 * Configure in ~/.codex/config.toml:
 * 
 * [mcp_servers.angelscript]
 * command = "node"
 * args = ["path/to/mcp-server/out/index.js"]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";

// Import language-server modules
import * as api_docs from "../../language-server/out/api_docs.js";
import * as typedb from "../../language-server/out/database.js";

// Tool definition matching the VS Code extension's languageModelTools
const ANGELSCRIPT_SEARCH_TOOL: Tool = {
    name: "angelscript_searchApi",
    description: "Search the Angelscript API database for symbols and documentation. Provide a query string and optionally limit the results or include documentation details.",
    inputSchema: {
        type: "object" as const,
        properties: {
            query: {
                type: "string",
                description: "Search query text for Angelscript API symbols."
            },
            limit: {
                type: "number",
                description: "Maximum number of results to return (1-1000).",
                default: 500,
                minimum: 1,
                maximum: 1000
            },
            includeDetails: {
                type: "boolean",
                description: "Include documentation details for top matches.",
                default: true
            }
        },
        required: ["query"]
    }
};

interface SearchParams {
    query: string;
    limit?: number;
    includeDetails?: boolean;
}

interface SearchResultItem {
    label: string;
    type?: string;
    data?: unknown;
    details?: string;
}

interface SearchPayload {
    query: string;
    total: number;
    returned: number;
    truncated: boolean;
    items: SearchResultItem[];
}

/**
 * Perform the API search, mirroring the VS Code extension's AngelscriptSearchApiTool
 */
async function performApiSearch(params: SearchParams): Promise<string> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    
    if (!query) {
        return "No query provided. Please supply a search query.";
    }

    // Check if types are loaded
    if (!typedb.HasTypesFromUnreal()) {
        return "Angelscript types have not been loaded. The type database is empty. " +
               "This typically means the Unreal Engine connection has not been established, " +
               "or no type data has been cached. Please ensure the Unreal Editor is running " +
               "and connected, or that cached type data is available.";
    }

    try {
        const limit = typeof params.limit === "number"
            ? Math.min(Math.max(Math.floor(params.limit), 1), 1000)
            : 500;
        const includeDetails = params.includeDetails !== false;

        const results = api_docs.GetAPISearch(query);
        
        if (!results || results.length === 0) {
            return `No Angelscript API results for "${query}".`;
        }

        const items = results.slice(0, limit);
        const payload: SearchPayload = {
            query,
            total: results.length,
            returned: items.length,
            truncated: results.length > items.length,
            items: items.map((item: any) => ({
                label: item.label,
                type: item.type ?? undefined,
                data: item.data ?? undefined
            }))
        };

        // Fetch details for each item if requested
        if (includeDetails) {
            for (const item of payload.items) {
                if (item.data) {
                    try {
                        const details = api_docs.GetAPIDetails(item.data);
                        if (details) {
                            item.details = details;
                        }
                    } catch (error) {
                        console.error(`Failed to fetch details for ${item.label}:`, error);
                    }
                }
            }
        }

        return JSON.stringify(payload, null, 2);
    } catch (error) {
        console.error("angelscript_searchApi tool failed:", error);
        return "The Angelscript API tool failed to run. Please ensure the type database is properly initialized.";
    }
}

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
    const server = new Server(
        {
            name: "angelscript-mcp-server",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // Handle list_tools request
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [ANGELSCRIPT_SEARCH_TOOL],
        };
    });

    // Handle call_tool request
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === "angelscript_searchApi") {
            const params = args as unknown as SearchParams;
            const result = await performApiSearch(params);
            
            return {
                content: [
                    {
                        type: "text" as const,
                        text: result,
                    },
                ],
            };
        }

        return {
            content: [
                {
                    type: "text" as const,
                    text: `Unknown tool: ${name}`,
                },
            ],
            isError: true,
        };
    });

    return server;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
    const server = createServer();
    const transport = new StdioServerTransport();

    await server.connect(transport);

    // Log to stderr since stdout is used for MCP communication
    console.error("Angelscript MCP Server started");
    console.error("Available tools: angelscript_searchApi");
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
