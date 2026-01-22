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
    SearchSource,
    buildSearchPayload,
    isUnrealConnected,
    toApiErrorPayload
} from './angelscriptApiSearch';
import { GetAPIDetailsRequest, GetTypeMembersRequest, GetTypeMembersResult, ResolveSymbolAtPositionRequest } from './apiRequests';

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
const SEARCH_RESOURCE_TEMPLATE = `${RESOURCE_BASE}search{?labelQuery,searchIndex,maxBatchResults,includeDocs,labelQueryUseRegex,signatureRegex,source,kinds}`;
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

function getMultiVariable(variables: TemplateVariables, key: string): string[]
{
    const raw = variables[key];
    if (Array.isArray(raw))
    {
        return raw;
    }
    if (typeof raw === 'string')
    {
        return [raw];
    }
    return [];
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

function parseSearchIndex(raw: string | undefined): number
{
    if (raw === undefined)
    {
        return Number.NaN;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0)
    {
        return Number.NaN;
    }
    return Number(trimmed);
}

function parseMaxBatchResults(raw: string | undefined): number | undefined
{
    if (raw === undefined)
    {
        return undefined;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0)
    {
        return Number.NaN;
    }
    return Number(trimmed);
}

function parseIncludeDocs(raw: string | undefined): boolean | undefined
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

function parseLabelQueryUseRegex(raw: string | undefined): boolean | undefined
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

function parseSource(raw: string | undefined): string | undefined
{
    if (raw === undefined)
    {
        return undefined;
    }
    const decoded = decodeURIComponentSafe(raw);
    if (typeof decoded !== 'string')
    {
        return undefined;
    }
    const trimmed = decoded.trim().toLowerCase();
    if (trimmed.length === 0)
    {
        return undefined;
    }
    return trimmed;
}

function parseKinds(rawValues: string[]): string[] | undefined
{
    if (rawValues.length === 0)
    {
        return undefined;
    }
    const parsed: string[] = [];
    for (const value of rawValues)
    {
        const decoded = decodeURIComponentSafe(value);
        if (!decoded)
        {
            continue;
        }
        for (const part of decoded.split(','))
        {
            const trimmed = part.trim();
            if (trimmed.length > 0)
            {
                parsed.push(trimmed);
            }
        }
    }
    return parsed.length > 0 ? parsed : undefined;
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
            description: 'Search Angelscript API symbols and docs. Spaces act as ordered wildcards; use "a b" to match a...b. Use "|" to separate alternate queries (OR). Use "." or "::" to require those separators; without a space they must be adjacent (e.g., "UObject." or "Math::"), with a space they stay fuzzy (e.g., "UObject ." or "Math ::"). Optional kinds filter: class, struct, enum, method, function, property, globalVariable (case-insensitive, multiple allowed). Optional source filter: native, script, both (default). Signature is always returned; includeDocs controls documentation payload. Paging uses searchIndex (required) and maxBatchResults (default 200). Set labelQueryUseRegex to true to apply a regex to labelQuery after kind filtering; supports /pattern/flags (omit i for case-sensitive). If not using /pattern/flags, default ignore case. Set signatureRegex to filter parsed signatures using a regex (supports /pattern/flags).',
            inputSchema: {
                labelQuery: z.string().describe('Search query text for Angelscript API symbols.'),
                searchIndex: z.number().int().describe('0-based start index for paged results.'),
                maxBatchResults: z.number().int().optional().describe('Maximum number of results to return in this batch. Default is 200.'),
                includeDocs: z.boolean().optional().describe('Include documentation text in the docs field. Default is false.'),
                labelQueryUseRegex: z.boolean().optional().describe('Treat labelQuery as a regular expression applied to labels after kind filtering. Supports /pattern/flags (omit i for case-sensitive). If not using /pattern/flags, default ignore case. Default is false.'),
                signatureRegex: z.string().optional().describe('Regular expression to filter parsed signatures. Supports /pattern/flags (omit i for case-sensitive). If not using /pattern/flags, default ignore case.'),
                source: z.enum(['native', 'script', 'both']).optional().describe('Filter results by source. Supported values: native, script, both. Default is both.'),
                kinds: z.array(z.string().min(1)).optional().describe('Filter results by kinds. Supported values: class, struct, enum, method, function, property, globalVariable. Case-insensitive; multiple values allowed.')
            }
        },
        async (args, extra) =>
        {
            const searchIndex = Number(args?.searchIndex);
            const labelQuery = typeof args?.labelQuery === 'string' ? args.labelQuery.trim() : '';
            if (!labelQuery)
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'MISSING_LABEL_QUERY',
                                    message: 'Missing labelQuery. Please provide labelQuery.'
                                }
                            }, null, 2)
                        }
                    ]
                };
            }
            const maxBatchResults = args?.maxBatchResults;

            try
            {
                await startedClient;
                const isConnected = await isUnrealConnected(client);
                if (!isConnected)
                {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    ok: false,
                                    error: {
                                        code: 'UE_UNAVAILABLE',
                                        message: 'Unable to connect to the UE5 engine; the angelscript_searchApi tool is unavailable.'
                                    }
                                }, null, 2)
                            }
                        ]
                    };
                }
                const payload = await buildSearchPayload(
                    client,
                    {
                        labelQuery,
                        searchIndex,
                        maxBatchResults,
                        includeDocs: args?.includeDocs,
                        labelQueryUseRegex: args?.labelQueryUseRegex,
                        signatureRegex: args?.signatureRegex,
                        source: args?.source as SearchSource | undefined,
                        kinds: args?.kinds
                    },
                    () => extra.signal.aborted
                );
                const payloadWithUris = attachResourceUris(payload);
                if (payloadWithUris.items.length === 0)
                {
                    const request: Record<string, unknown> = {
                        labelQuery,
                        searchIndex,
                        maxBatchResults: maxBatchResults ?? 200,
                        kinds: args?.kinds,
                        source: args?.source ?? "both",
                        labelQueryUseRegex: args?.labelQueryUseRegex === true,
                    };
                    const signatureRegex = typeof args?.signatureRegex === "string"
                        ? args.signatureRegex.trim()
                        : "";
                    if (signatureRegex)
                    {
                        request.signatureRegex = signatureRegex;
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    ...payloadWithUris,
                                    text: `No Angelscript API results for "${labelQuery}".`,
                                    request
                                }, null, 2)
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
            } catch (error)
            {
                const apiError = toApiErrorPayload(error);
                if (apiError)
                {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(apiError, null, 2)
                            }
                        ]
                    };
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'INTERNAL_ERROR',
                                    message: 'The Angelscript API tool failed to run. Please ensure the language server is running and try again.'
                                }
                            }, null, 2)
                        }
                    ]
                };
            }
        }
    );

    server.registerTool(
        'angelscript_resolveSymbolAtPosition',
        {
            description: 'Resolve a symbol at a given document position and return its kind, full signature, definition location, and optional documentation.',
            inputSchema: {
                uri: z.string().describe('Document URI for the file containing the symbol.'),
                position: z.object({
                    line: z.number().int().min(0).describe('0-based line number.'),
                    character: z.number().int().min(0).describe('0-based character offset.'),
                }),
                includeDocumentation: z.boolean().optional().describe('Include documentation when available. Default is true.'),
            }
        },
        async (args) =>
        {
            const uri = typeof args?.uri === 'string' ? args.uri.trim() : '';
            const position = args?.position;
            const line = typeof position?.line === 'number' ? position.line : null;
            const character = typeof position?.character === 'number' ? position.character : null;

            if (!uri || line === null || character === null)
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'InvalidParams',
                                    message: 'Invalid params. Provide uri and position { line, character }.'
                                }
                            }, null, 2)
                        }
                    ]
                };
            }

            try
            {
                await startedClient;
                const includeDocumentation = args?.includeDocumentation !== false;
                const result = await client.sendRequest(
                    ResolveSymbolAtPositionRequest,
                    {
                        uri,
                        position: { line, character },
                        includeDocumentation,
                    }
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2)
                        }
                    ]
                };
            }
            catch
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'INTERNAL_ERROR',
                                    message: 'The resolveSymbolAtPosition tool failed to run. Please ensure the language server is running and try again.'
                                }
                            }, null, 2)
                        }
                    ]
                };
            }
        }
    );

    server.registerTool(
        'angelscript_getTypeMembers',
        {
            description: 'List all members (methods, properties, accessors, mixins) for a type, including inherited members when requested.',
            inputSchema: {
                name: z.string().describe('Type name to inspect.'),
                namespace: z.string().optional().describe('Optional namespace to disambiguate type name. Use empty string for root namespace.'),
                includeInherited: z.boolean().optional().describe('Include inherited members (default false).'),
                includeDocs: z.boolean().optional().describe('Include description text (default false).'),
                kinds: z.enum(['both', 'method', 'property']).optional().describe('Filter by member kind (default both).')
            }
        },
        async (args) =>
        {
            const name = typeof args?.name === 'string' ? args.name.trim() : '';
            if (!name)
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'InvalidParams',
                                    message: "Invalid params. 'name' must be a non-empty string."
                                }
                            }, null, 2)
                        }
                    ]
                };
            }

            const namespace = typeof args?.namespace === 'string' ? args.namespace.trim() : undefined;
            const includeInherited = args?.includeInherited === true;
            const includeDocs = args?.includeDocs === true;
            const kinds = typeof args?.kinds === 'string' ? args.kinds.trim() : undefined;

            try
            {
                await startedClient;
                const isConnected = await isUnrealConnected(client);
                if (!isConnected)
                {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    ok: false,
                                    error: {
                                        code: 'UE_UNAVAILABLE',
                                        message: 'Unable to connect to the UE5 engine; the angelscript_getTypeMembers tool is unavailable.'
                                    }
                                }, null, 2)
                            }
                        ]
                    };
                }
                const result = await client.sendRequest<GetTypeMembersResult>(
                    GetTypeMembersRequest.method,
                    {
                    name,
                    namespace,
                    includeInherited,
                    includeDocs,
                    kinds,
                }
            );
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2)
                        }
                    ]
                };
            }
            catch
            {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'INTERNAL_ERROR',
                                    message: 'The angelscript_getTypeMembers tool failed to run. Please ensure the language server is running and try again.'
                                }
                            }, null, 2)
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
            const searchIndex = parseSearchIndex(getSingleVariable(variables, 'searchIndex'));
            const maxBatchResults = parseMaxBatchResults(getSingleVariable(variables, 'maxBatchResults'));
            const includeDocsParam = parseIncludeDocs(getSingleVariable(variables, 'includeDocs'));
            const labelQueryUseRegexParam = parseLabelQueryUseRegex(getSingleVariable(variables, 'labelQueryUseRegex'));
            const signatureRegex = decodeURIComponentSafe(getSingleVariable(variables, 'signatureRegex'))?.trim();
            const source = parseSource(getSingleVariable(variables, 'source')) as SearchSource | undefined;
            const kinds = parseKinds(getMultiVariable(variables, 'kinds'));
            const includeDocs = includeDocsParam ?? false;
            const labelQueryUseRegex = labelQueryUseRegexParam ?? false;

            const labelQuery = decodeURIComponentSafe(getSingleVariable(variables, 'labelQuery'))?.trim() ?? '';
            if (!labelQuery)
            {
                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'MISSING_LABEL_QUERY',
                                    message: 'Missing labelQuery. Please provide labelQuery.'
                                }
                            }, null, 2)
                        }
                    ]
                };
            }

            try
            {
                await startedClient;
                const isConnected = await isUnrealConnected(client);
                if (!isConnected)
                {
                    return {
                        contents: [
                            {
                                uri: uri.toString(),
                                mimeType: 'application/json',
                                text: JSON.stringify({
                                    ok: false,
                                    error: {
                                        code: 'UE_UNAVAILABLE',
                                        message: 'Unable to connect to the UE5 engine; the angelscript_searchApi tool is unavailable.'
                                    }
                                }, null, 2)
                            }
                        ]
                    };
                }
                const payload = await buildSearchPayload(
                    client,
                    {
                        labelQuery,
                        searchIndex,
                        maxBatchResults,
                        includeDocs,
                        labelQueryUseRegex,
                        signatureRegex,
                        source,
                        kinds
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
            } catch (error)
            {
                const apiError = toApiErrorPayload(error);
                if (apiError)
                {
                    return {
                        contents: [
                            {
                                uri: uri.toString(),
                                mimeType: 'application/json',
                                text: JSON.stringify(apiError, null, 2)
                            }
                        ]
                    };
                }
                return {
                    contents: [
                        {
                            uri: uri.toString(),
                            mimeType: 'application/json',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'RESOURCE_ERROR',
                                    message: 'Failed to read Angelscript API search resource.'
                                }
                            }, null, 2)
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
