import * as http from 'http';
import { URL } from 'url';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// ResourceTemplate is available at runtime but not exported in the typed server entry, so require the CJS build.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
const { ResourceTemplate }: { ResourceTemplate: new (...args: any[]) => any } = require('@modelcontextprotocol/sdk/server/mcp.js');
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import
{
    ApiResponsePayload,
    ApiResultItem,
    buildSearchPayload
} from './angelscriptApiSearch';
import { GetAPIDetailsRequest } from './apiRequests';

type McpTransport = {
    handleRequest: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => Promise<void>;
    close: () => Promise<void>;
};

type McpServerLike = InstanceType<typeof McpServer>;

type McpHttpServerState = {
    httpServer: http.Server;
    transport: McpTransport;
    mcpServer: McpServerLike;
};

const SERVER_ID = 'angelscript-api-mcp';
const RESOURCE_BASE = `mcp://${SERVER_ID}/`;
const SEARCH_RESOURCE_TEMPLATE = `${RESOURCE_BASE}search{?query,limit,includeDetails}`;
const SYMBOL_RESOURCE_TEMPLATE = `${RESOURCE_BASE}symbol/{id}`;
const HEALTH_TIMEOUT_MS = 400;
const POLL_INTERVAL_OK_MS = 3000;
const POLL_INTERVAL_RETRY_MS = 1000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
type TemplateVariables = Record<string, string | string[] | undefined>;

function getSingleVariable(variables: TemplateVariables, key: string): string | undefined
{
    const raw = variables[key];
    if (Array.isArray(raw))
    {
        return raw[0];
    }
    if (typeof raw === 'string')
    {
        return raw;
    }
    return undefined;
}

function decodeURIComponentSafe(value: string | undefined): string | undefined
{
    if (typeof value !== 'string')
    {
        return value;
    }
    try
    {
        return decodeURIComponent(value);
    } catch
    {
        return value;
    }
}

function parseLimit(raw: string | undefined): number | undefined
{
    if (!raw)
    {
        return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed))
    {
        return undefined;
    }
    return parsed;
}

function parseIncludeDetails(raw: string | undefined): boolean | undefined
{
    if (raw === undefined)
    {
        return undefined;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === '')
    {
        return undefined;
    }
    if (normalized === 'true' || normalized === '1')
    {
        return true;
    }
    if (normalized === 'false' || normalized === '0')
    {
        return false;
    }
    return undefined;
}

function encodeSymbolId(data: unknown): string | undefined
{
    try
    {
        const json = JSON.stringify(data ?? null);
        return encodeURIComponent(json);
    } catch
    {
        return undefined;
    }
}

function decodeSymbolId(raw: string): unknown
{
    try
    {
        return JSON.parse(decodeURIComponent(raw));
    } catch
    {
        return raw;
    }
}

function formatSymbolUri(data: unknown): string | undefined
{
    const encoded = encodeSymbolId(data);
    if (!encoded)
    {
        return undefined;
    }
    return SYMBOL_RESOURCE_TEMPLATE.replace('{id}', encoded);
}

function attachResourceUris(payload: ApiResponsePayload): ApiResponsePayload & { items: Array<ApiResultItem & { resourceUri?: string }> }
{
    return {
        ...payload,
        items: payload.items.map((item) => ({
            ...item,
            resourceUri: formatSymbolUri(item.data)
        }))
    };
}

let serverState: McpHttpServerState | null = null;
let pollingTimer: NodeJS.Timeout | null = null;
let failedStartupAttempts = 0;
let stopPolling = false;
let isPolling = false;

function getMcpPort(): number
{
    const config = vscode.workspace.getConfiguration('UnrealAngelscript');
    const explicitPort = config.get<number>('mcp.port', 0);
    if (typeof explicitPort === 'number' && explicitPort > 0)
    {
        return explicitPort;
    }
    const unrealPort = config.get<number>('unrealConnectionPort', 27099);
    return (typeof unrealPort === 'number' ? unrealPort : 27099) + 100;
}

function isMcpEnabled(): boolean
{
    const config = vscode.workspace.getConfiguration('UnrealAngelscript');
    return config.get<boolean>('mcp.enabled', true);
}

function getMaxStartupFailures(): number
{
    const config = vscode.workspace.getConfiguration('UnrealAngelscript');
    const configured = config.get<number>('mcp.maxStartupFailures', 5);
    if (typeof configured === 'number' && configured > 0)
    {
        return configured;
    }
    return 5;
}

type HealthStatus = 'ok' | 'mismatch' | 'unreachable';

async function requestHealth(port: number): Promise<{ serverId?: string } | null>
{
    return await new Promise((resolve) =>
    {
        const url = new URL(`http://127.0.0.1:${port}/health`);
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'GET',
                timeout: HEALTH_TIMEOUT_MS
            },
            (res) =>
            {
                const chunks: Buffer[] = [];
                let responseBytes = 0;
                let responseTooLarge = false;
                res.on('data', (chunk) =>
                {
                    if (responseTooLarge)
                    {
                        return;
                    }
                    responseBytes += chunk.length;
                    if (responseBytes > MAX_HEALTH_RESPONSE_BYTES)
                    {
                        responseTooLarge = true;
                        res.destroy();
                        resolve(null);
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () =>
                {
                    if (responseTooLarge)
                    {
                        resolve(null);
                        return;
                    }
                    if (res.statusCode !== 200)
                    {
                        resolve(null);
                        return;
                    }
                    try
                    {
                        const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                        resolve(payload);
                    } catch
                    {
                        resolve(null);
                    }
                });
            }
        );
        req.on('timeout', () =>
        {
            req.destroy();
            resolve(null);
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function checkMcpServer(port: number): Promise<HealthStatus>
{
    const health = await requestHealth(port);
    if (!health)
    {
        return 'unreachable';
    }
    if (health.serverId === SERVER_ID)
    {
        return 'ok';
    }
    return 'mismatch';
}

function createMcpServer(client: LanguageClient, startedClient: Promise<void>): McpServerLike
{
    const server = new McpServer({
        name: SERVER_ID,
        version: '1.0.0'
    });

    server.registerTool(
        'angelscript_searchApi',
        {
            description: 'Search the Angelscript API database for symbols and documentation. The limit parameter defaults to 1000 and must not be below 1000. The includeDetails parameter defaults to true and should not be passed unless you specifically need to exclude documentation. Do NOT pass limit or includeDetails unless you need specific values. Omit both parameters to use defaults.',
            inputSchema: {
                query: z.string().describe('Search query text for Angelscript API symbols.'),
                limit: z.number().min(1000).optional().describe('Maximum number of results. Minimum is 1000. Default is 1000. Do NOT pass this parameter unless you need a specific value. Never pass values below 1000.'),
                includeDetails: z.boolean().optional().describe('Include documentation details for top matches. Default is true. Do NOT pass this parameter unless you specifically need to exclude documentation. Omit to use the default.')
            }
        },
        async (args, extra) =>
        {
            const query = typeof args?.query === 'string' ? args.query.trim() : '';
            if (!query)
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'No query provided. Please supply a search query.'
                        }
                    ]
                };
            }

            try
            {
                await startedClient;
                const payload = await buildSearchPayload(
                    client,
                    {
                        query,
                        limit: args?.limit,
                        includeDetails: args?.includeDetails
                    },
                    () => extra.signal.aborted
                );
                const payloadWithUris = attachResourceUris(payload);

                if (payloadWithUris.items.length === 0)
                {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No Angelscript API results for "${query}".`
                            }
                        ]
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(payloadWithUris, null, 2)
                        }
                    ]
                };
            } catch
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'The Angelscript API tool failed to run. Please ensure the language server is running and try again.'
                        }
                    ]
                };
            }
        }
    );

    server.registerResource(
        'angelscript_searchApi',
        new ResourceTemplate(SEARCH_RESOURCE_TEMPLATE, {}),
        {
            name: 'Angelscript API Search',
            description: 'Search the Angelscript API database via resource template (same as angelscript_searchApi tool).',
            mimeType: 'application/json'
        },
        async (uri, variables, extra) =>
        {
            const query = decodeURIComponentSafe(getSingleVariable(variables, 'query'))?.trim() ?? '';
            const limit = parseLimit(getSingleVariable(variables, 'limit'));
            const includeDetailsParam = parseIncludeDetails(getSingleVariable(variables, 'includeDetails'));
            // Default to true when unspecified to match buildSearchPayload behavior (includeDetails !== false).
            const includeDetails = includeDetailsParam ?? true;

            if (!query)
            {
                const emptyPayload: ApiResponsePayload = {
                    query,
                    total: 0,
                    returned: 0,
                    truncated: false,
                    items: []
                };
                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'application/json',
                            text: JSON.stringify(emptyPayload, null, 2)
                        }
                    ]
                };
            }

            try
            {
                await startedClient;
                const payload = await buildSearchPayload(
                    client,
                    {
                        query,
                        limit,
                        includeDetails
                    },
                    () => extra.signal?.aborted ?? false
                );
                const payloadWithUris = attachResourceUris(payload);

                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'application/json',
                            text: JSON.stringify(payloadWithUris, null, 2)
                        }
                    ]
                };
            } catch
            {
                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'text/plain',
                            text: 'Failed to read Angelscript API search resource.'
                        }
                    ]
                };
            }
        }
    );

    server.registerResource(
        'angelscript_symbolDetails',
        new ResourceTemplate(SYMBOL_RESOURCE_TEMPLATE, {}),
        {
            name: 'Angelscript API Symbol Detail',
            description: 'Fetch Angelscript API symbol documentation using the encoded symbol id from search results.',
            mimeType: 'text/markdown'
        },
        async (uri, variables, extra) =>
        {
            const rawId = getSingleVariable(variables, 'id');
            if (!rawId)
            {
                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'text/plain',
                            text: 'No symbol id provided.'
                        }
                    ]
                };
            }

            const decodedId = decodeSymbolId(rawId);

            try
            {
                await startedClient;
                const details = await client.sendRequest(GetAPIDetailsRequest, decodedId);
                const text =
                    typeof details === 'string' && details.trim().length > 0
                        ? details
                        : 'No details available for this symbol.';

                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'text/markdown',
                            text
                        }
                    ]
                };
            } catch
            {
                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'text/plain',
                            text: 'Failed to fetch Angelscript API symbol details.'
                        }
                    ]
                };
            }
        }
    );

    return server;
}

async function tryStartHttpServer(client: LanguageClient, startedClient: Promise<void>): Promise<boolean>
{
    if (serverState)
    {
        return true;
    }

    const port = getMcpPort();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });
    const mcpServer = createMcpServer(client, startedClient);
    await mcpServer.connect(transport);

    const httpServer = http.createServer((req, res) =>
    {
        if (req.method === 'GET' && req.url)
        {
            const requestUrl = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
            if (requestUrl.pathname === '/health')
            {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ serverId: SERVER_ID }));
                return;
            }
        }
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        let bodyTooLarge = false;
        req.on('data', (chunk) =>
        {
            if (bodyTooLarge)
            {
                return;
            }
            bodyBytes += chunk.length;
            if (bodyBytes > MAX_REQUEST_BODY_BYTES)
            {
                bodyTooLarge = true;
                res.statusCode = 413;
                res.end('Payload Too Large');
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', async () =>
        {
            if (bodyTooLarge)
            {
                return;
            }
            const bodyText = Buffer.concat(chunks).toString('utf-8');
            let parsedBody: unknown = undefined;
            if (bodyText)
            {
                try
                {
                    parsedBody = JSON.parse(bodyText);
                } catch
                {
                    parsedBody = undefined;
                }
            }
            try
            {
                await transport.handleRequest(req, res, parsedBody);
            } catch
            {
                if (!res.headersSent)
                {
                    res.statusCode = 500;
                }
                res.end();
            }
        });
    });

    return await new Promise<boolean>((resolve) =>
    {
        httpServer.once('error', async (error: NodeJS.ErrnoException) =>
        {
            if (error.code === 'EADDRINUSE')
            {
                await transport.close().catch(() => undefined);
                resolve(false);
                return;
            }
            await transport.close().catch(() => undefined);
            resolve(false);
        });

        httpServer.listen(port, '127.0.0.1', () =>
        {
            try
            {
                serverState = { httpServer, transport, mcpServer };
                resolve(true);
            } catch
            {
                httpServer.close();
                transport.close().catch(() => undefined);
                resolve(false);
            }
        });
    });
}

function disposeServer(): void
{
    if (!serverState)
    {
        return;
    }
    serverState.transport.close().catch(() => undefined);
    serverState.httpServer.close();
    serverState = null;
}

async function pollForServer(client: LanguageClient, startedClient: Promise<void>): Promise<void>
{
    if (isPolling || stopPolling)
    {
        return;
    }
    if (!isMcpEnabled())
    {
        if (pollingTimer)
        {
            clearTimeout(pollingTimer);
            pollingTimer = null;
        }
        return;
    }

    const schedulePoll = (delayMs: number) =>
    {
        if (stopPolling)
        {
            return;
        }
        if (pollingTimer)
        {
            clearTimeout(pollingTimer);
        }
        pollingTimer = setTimeout(() =>
        {
            pollingTimer = null;
            pollForServer(client, startedClient);
        }, delayMs);
    };

    isPolling = true;
    try
    {
        const port = getMcpPort();
        const handshakeStatus = await checkMcpServer(port);
        if (handshakeStatus === 'ok')
        {
            failedStartupAttempts = 0;
            schedulePoll(POLL_INTERVAL_OK_MS);
            return;
        }
        if (handshakeStatus === 'mismatch')
        {
            stopPolling = true;
            if (pollingTimer)
            {
                clearTimeout(pollingTimer);
                pollingTimer = null;
            }
            vscode.window.showErrorMessage(
                `检测到端口 ${port} 上有非本插件的 MCP 服务，已停止自动启动。请修改 UnrealAngelscript.mcp.port。`
            );
            return;
        }

        const started = await tryStartHttpServer(client, startedClient);
        if (started)
        {
            failedStartupAttempts = 0;
            schedulePoll(POLL_INTERVAL_OK_MS);
            return;
        }

        failedStartupAttempts += 1;
        if (failedStartupAttempts >= getMaxStartupFailures())
        {
            stopPolling = true;
            if (pollingTimer)
            {
                clearTimeout(pollingTimer);
                pollingTimer = null;
            }
            vscode.window.showErrorMessage(
                `端口 ${port} 被占用且无法连接 /health，已停止重试。请更换端口或关闭占用服务。`
            );
            return;
        }

        schedulePoll(POLL_INTERVAL_RETRY_MS);
    } finally
    {
        isPolling = false;
    }
}

export function startMcpHttpServerManager(
    context: vscode.ExtensionContext,
    client: LanguageClient,
    startedClient: Promise<void>
): void
{
    failedStartupAttempts = 0;
    stopPolling = false;
    isPolling = false;
    if (pollingTimer)
    {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }

    const disposable = vscode.workspace.onDidChangeConfiguration((event) =>
    {
        if (event.affectsConfiguration('UnrealAngelscript.mcp'))
        {
            disposeServer();
            if (pollingTimer)
            {
                clearTimeout(pollingTimer);
                pollingTimer = null;
            }
            failedStartupAttempts = 0;
            stopPolling = false;
            isPolling = false;
            pollForServer(client, startedClient);
        }
    });

    const managerDisposable = {
        dispose: () =>
        {
            disposeServer();
            if (pollingTimer)
            {
                clearTimeout(pollingTimer);
                pollingTimer = null;
            }
            failedStartupAttempts = 0;
            stopPolling = true;
            isPolling = false;
        }
    };

    context.subscriptions.push(disposable, managerDisposable);

    if (isMcpEnabled())
    {
        pollForServer(client, startedClient);
    }
}
