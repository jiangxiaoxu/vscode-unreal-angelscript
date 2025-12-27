/**
 * MCP Server for Angelscript API Search
 * 
 * This module provides an MCP server that is started by the VS Code extension
 * and shares the LanguageClient with the extension. It exposes the same
 * angelscript_searchApi tool functionality via the MCP protocol.
 * 
 * The server uses STDIO transport. To use with Codex, start the MCP server
 * via the 'angelscript.startMcpServer' command in VS Code.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { LanguageClient, RequestType } from 'vscode-languageclient/node';

const GetAPISearchRequest = new RequestType<any, any[], void>('angelscript/getAPISearch');
const GetAPIDetailsRequest = new RequestType<any, string, void>('angelscript/getAPIDetails');

// Tool definition matching the VS Code extension's languageModelTools schema
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
 * MCP Server class that wraps the LanguageClient for API search
 */
export class AngelscriptMcpServer {
    private server: Server;
    private client: LanguageClient;
    private clientReady: Promise<void>;
    private transport: StdioServerTransport | null = null;

    constructor(client: LanguageClient, clientReady: Promise<void>) {
        this.client = client;
        this.clientReady = clientReady;
        this.server = this.createServer();
    }

    /**
     * Create and configure the MCP server
     */
    private createServer(): Server {
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
                const result = await this.performApiSearch(params);
                
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
     * Perform the API search using the shared LanguageClient
     */
    private async performApiSearch(params: SearchParams): Promise<string> {
        const query = typeof params.query === "string" ? params.query.trim() : "";
        
        if (!query) {
            return "No query provided. Please supply a search query.";
        }

        try {
            // Wait for client to be ready
            await this.clientReady;
            
            const limit = typeof params.limit === "number"
                ? Math.min(Math.max(Math.floor(params.limit), 1), 1000)
                : 500;
            const includeDetails = params.includeDetails !== false;

            // Use the shared LanguageClient to search
            const results = await this.client.sendRequest(GetAPISearchRequest, query);
            
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
                // Use concurrent requests with limit
                const CONCURRENCY_LIMIT = 10;
                const allDetails: Array<{ index: number; details?: string }> = [];
                let nextIndex = 0;
                let activeCount = 0;
                const totalItems = payload.items.length;

                if (totalItems > 0) {
                    await new Promise<void>((resolveAll) => {
                        const startNext = () => {
                            // Fill up to CONCURRENCY_LIMIT active requests
                            while (nextIndex < totalItems && activeCount < CONCURRENCY_LIMIT) {
                                const currentIndex = nextIndex;
                                const item = payload.items[currentIndex];
                                const itemData = item.data;
                                nextIndex++;
                                activeCount++;

                                this.client.sendRequest(GetAPIDetailsRequest, itemData)
                                    .then((details: string) => {
                                        allDetails.push({ index: currentIndex, details });
                                    })
                                    .catch((error: any) => {
                                        console.error(`Failed to fetch details for ${item.label}:`, error);
                                        allDetails.push({ index: currentIndex, details: undefined });
                                    })
                                    .finally(() => {
                                        activeCount--;
                                        if (nextIndex >= totalItems && activeCount === 0) {
                                            resolveAll();
                                        } else {
                                            startNext();
                                        }
                                    });
                            }
                        };

                        startNext();
                    });
                }

                // Map details back to items by index
                for (const detail of allDetails) {
                    payload.items[detail.index].details = detail.details;
                }
            }

            return JSON.stringify(payload, null, 2);
        } catch (error) {
            console.error("angelscript_searchApi MCP tool failed:", error);
            return "The Angelscript API tool failed to run. Please ensure the language server is running and try again.";
        }
    }

    /**
     * Start the MCP server with STDIO transport
     */
    async start(): Promise<void> {
        this.transport = new StdioServerTransport();
        await this.server.connect(this.transport);
        // Note: Using console.error because stdout is reserved for MCP communication
        console.error("Angelscript MCP Server started (extension-integrated)");
        console.error("Available tools: angelscript_searchApi");
    }

    /**
     * Stop the MCP server
     */
    async stop(): Promise<void> {
        if (this.transport) {
            await this.server.close();
            this.transport = null;
            // Note: Using console.error because stdout is reserved for MCP communication
            console.error("Angelscript MCP Server stopped");
        }
    }
}
