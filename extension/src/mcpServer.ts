import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { LanguageClient } from 'vscode-languageclient/node';
import { CancellationTokenSource } from 'vscode-languageclient';

const MCP_SERVER_ID = 'unreal-angelscript-mcp';
const HEALTH_PATH = '/health';
const MCP_PATH = '/mcp';
const DEFAULT_PROBE_INTERVAL_MS = 1000;
const HEALTH_TIMEOUT_MS = 400;
const CONCURRENCY_LIMIT = 10;

type AngelscriptSearchItem = {
    label: string;
    type?: string;
    data?: unknown;
};

type AngelscriptSearchPayload = {
    query: string;
    total: number;
    returned: number;
    truncated: boolean;
    items: Array<AngelscriptSearchItem & { details?: string }>;
};

export function startMcpServer(context: vscode.ExtensionContext, client: LanguageClient, startedClient: Promise<void>)
{
    const state = new McpServerState(context, client, startedClient);
    state.start();
    context.subscriptions.push(state);
}

class McpServerState implements vscode.Disposable
{
    private readonly context: vscode.ExtensionContext;
    private readonly client: LanguageClient;
    private readonly startedClient: Promise<void>;

    private probeTimer: NodeJS.Timeout | null = null;
    private consecutiveFailures = 0;
    private stopped = false;

    private httpServer: import('http').Server | null = null;
    private mcpServer: McpServer | null = null;
    private transport: StreamableHTTPServerTransport | null = null;

    constructor(context: vscode.ExtensionContext, client: LanguageClient, startedClient: Promise<void>)
    {
        this.context = context;
        this.client = client;
        this.startedClient = startedClient;
    }

    start()
    {
        this.scheduleProbe();
    }

    dispose()
    {
        this.stopped = true;
        if (this.probeTimer)
        {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
        this.shutdownServer();
    }

    private async shutdownServer()
    {
        if (this.httpServer)
        {
            await new Promise<void>((resolve) =>
            {
                this.httpServer.close(() => resolve());
            });
            this.httpServer = null;
        }
        if (this.transport)
        {
            await this.transport.close();
            this.transport = null;
        }
        if (this.mcpServer)
        {
            await this.mcpServer.close();
            this.mcpServer = null;
        }
    }

    private scheduleProbe()
    {
        if (this.stopped)
            return;
        this.probeTimer = setTimeout(() => this.probe(), DEFAULT_PROBE_INTERVAL_MS);
    }

    private getConfig()
    {
        const cfg = vscode.workspace.getConfiguration('UnrealAngelscript');
        const unrealPort = cfg.get<number>('unrealConnectionPort', 27099);
        const configuredMcpPort = cfg.get<number>('mcp.port');
        const port = (configuredMcpPort && configuredMcpPort > 0 && configuredMcpPort < 65536)
            ? configuredMcpPort
            : Math.min(Math.max(unrealPort + 100, 1), 65535);
        const retries = cfg.get<number>('mcp.startupRetries', 5);
        return {
            port,
            retries: Math.max(1, retries),
        };
    }

    private async probe()
    {
        if (this.stopped)
            return;
        const { port, retries } = this.getConfig();

        const result = await this.checkHealth(port);
        if (result === 'ours')
        {
            // Already running, no more work.
            return;
        }
        if (result === 'other')
        {
            this.notifyError(`MCP HTTP port ${port} is already in use by another service.`, true);
            return;
        }

        // Not running, try to start.
        try
        {
            await this.startServer(port);
            return;
        }
        catch (err: any)
        {
            this.consecutiveFailures += 1;
            if (this.consecutiveFailures >= retries)
            {
                this.notifyError(`Failed to start MCP server on port ${port} after ${retries} attempts: ${err?.message ?? err}`, true);
                return;
            }
        }

        this.scheduleProbe();
    }

    private async checkHealth(port: number): Promise<'ours' | 'other' | 'absent'>
    {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
        try
        {
            const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
                signal: controller.signal,
            });
            if (!res.ok)
                return 'other';

            const body: any = await res.json();
            if (body?.serverId === MCP_SERVER_ID)
                return 'ours';
            return 'other';
        }
        catch
        {
            return 'absent';
        }
        finally
        {
            clearTimeout(timeout);
        }
    }

    private async startServer(port: number)
    {
        await this.shutdownServer();

        const app = createMcpExpressApp({ host: '127.0.0.1' });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
        });

        const implVersion = this.getExtensionVersion();
        const mcpServer = new McpServer(
            {
                name: 'Unreal Angelscript MCP',
                version: implVersion,
            },
            {
                capabilities: {
                    tools: { listChanged: false },
                    logging: {},
                },
            }
        );

        this.registerAngelscriptSearchTool(mcpServer);

        await mcpServer.connect(transport);

        app.get(HEALTH_PATH, (_req, res) =>
        {
            res.json({
                status: 'ok',
                serverId: MCP_SERVER_ID,
                version: implVersion,
            });
        });

        app.post(MCP_PATH, async (req, res) =>
        {
            try
            {
                await transport.handleRequest(req, res, req.body);
            }
            catch (err)
            {
                console.error('MCP POST handler failed:', err);
                if (!res.headersSent)
                    res.status(500).end();
            }
        });

        app.get(MCP_PATH, async (req, res) =>
        {
            try
            {
                await transport.handleRequest(req, res);
            }
            catch (err)
            {
                console.error('MCP GET handler failed:', err);
                if (!res.headersSent)
                    res.status(500).end();
            }
        });

        app.delete(MCP_PATH, async (req, res) =>
        {
            try
            {
                await transport.handleRequest(req, res);
            }
            catch (err)
            {
                console.error('MCP DELETE handler failed:', err);
                if (!res.headersSent)
                    res.status(500).end();
            }
        });

        await new Promise<void>((resolve, reject) =>
        {
            const server = app.listen(port, '127.0.0.1', () => resolve());
            server.once('error', (err) => reject(err));
            this.httpServer = server;
        });

        this.consecutiveFailures = 0;
        this.mcpServer = mcpServer;
        this.transport = transport;
    }

    private registerAngelscriptSearchTool(mcpServer: McpServer)
    {
        const inputSchema: z.ZodTypeAny = z.object({
            query: z.string().describe('Search query text for Angelscript API symbols.'),
            limit: z.number().int().min(1).max(1000).default(500)
                .describe('Maximum number of results to return (1-1000).'),
            includeDetails: z.boolean().default(true)
                .describe('Include documentation details for top matches.'),
        });
        type SearchArgs = { query: string; limit: number; includeDetails: boolean };
        type ToolExtra = { signal?: AbortSignal };

        type ToolRegisteringMcpServer = {
            registerTool: (
                name: string,
                definition: {
                    description?: string;
                    inputSchema?: z.ZodTypeAny;
                },
                handler: (rawArgs: unknown, extra: ToolExtra) => Promise<unknown> | unknown
            ) => void;
        };

        const serverWithTools = mcpServer as unknown as ToolRegisteringMcpServer;
        serverWithTools.registerTool(
            'Search_AngelScriptApi',
            {
                description: 'Search the Angelscript API database for symbols and documentation.',
                inputSchema,
            },
            async (rawArgs: unknown, extra: ToolExtra) =>
            {
                const parsed = inputSchema.safeParse(rawArgs ?? {});
                if (!parsed.success)
                {
                    return {
                        content: [
                            { type: 'text', text: 'Invalid tool input. Please provide a query string.' },
                        ],
                    };
                }

                const args = parsed.data as SearchArgs;
                const query = args.query.trim();
                if (!query)
                {
                    return {
                        content: [
                            { type: 'text', text: 'No query provided. Please supply a search query.' },
                        ],
                    };
                }

                await this.startedClient;
                const limit = Math.min(Math.max(Math.floor(args.limit), 1), 1000);
                const includeDetails = args.includeDetails !== false;

                try
                {
                    const payload = await this.runSearch(query, limit, includeDetails, extra.signal);
                    return {
                        content: [
                            { type: 'text', text: JSON.stringify(payload, null, 2) },
                        ],
                    };
                }
                catch (err: any)
                {
                    console.error('Search_AngelScriptApi failed:', err);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'The Angelscript API tool failed to run. Please ensure the language server is running and try again.',
                            },
                        ],
                    };
                }
            }
        );
    }

    private async runSearch(query: string, limit: number, includeDetails: boolean, signal: AbortSignal | undefined): Promise<AngelscriptSearchPayload>
    {
        const searchCancel = this.createCancellationFromSignal(signal);
        try
        {
            const results: any[] = await this.client.sendRequest('angelscript/getAPISearch', query, searchCancel?.token);
            if (!results || results.length === 0)
            {
                return {
                    query,
                    total: 0,
                    returned: 0,
                    truncated: false,
                    items: [],
                };
            }

            const items = results.slice(0, limit).map((item: any) => ({
                label: item.label,
                type: item.type ?? undefined,
                data: item.data ?? undefined,
            }));

            const payload: AngelscriptSearchPayload = {
                query,
                total: results.length,
                returned: items.length,
                truncated: results.length > items.length,
                items,
            };

            if (!includeDetails || items.length === 0)
                return payload;

            await this.fetchDetailsConcurrently(payload, signal);
            return payload;
        }
        finally
        {
            searchCancel?.dispose();
        }
    }

    private async fetchDetailsConcurrently(payload: AngelscriptSearchPayload, signal: AbortSignal | undefined)
    {
        const totalItems = payload.items.length;
        const allDetails: Array<{ index: number; details?: string }> = [];
        let nextIndex = 0;
        let active = 0;
        let resolved = false;
        let aborted = signal?.aborted ?? false;
        const detailsCancel = this.createCancellationFromSignal(signal);

        const tryResolve = (resolve: () => void) =>
        {
            if (!resolved && (aborted || (nextIndex >= totalItems && active === 0)))
            {
                resolved = true;
                resolve();
            }
        };

        signal?.addEventListener('abort', () =>
        {
            aborted = true;
        }, { once: true });

        await new Promise<void>((resolve) =>
        {
            const startNext = () =>
            {
                if (aborted)
                {
                    tryResolve(resolve);
                    return;
                }

                while (!aborted && nextIndex < totalItems && active < CONCURRENCY_LIMIT)
                {
                    const currentIndex = nextIndex++;
                    const item = payload.items[currentIndex];
                    active++;

                    this.client.sendRequest('angelscript/getAPIDetails', item.data, detailsCancel?.token)
                        .then((details: string) =>
                        {
                            if (!aborted)
                                allDetails.push({ index: currentIndex, details });
                        })
                        .catch((err) =>
                        {
                            console.error('Failed to fetch details for', item.label, err);
                            if (!aborted)
                                allDetails.push({ index: currentIndex, details: undefined });
                        })
                        .finally(() =>
                        {
                            active--;
                            tryResolve(resolve);
                            if (!resolved)
                                startNext();
                        });
                }
            };
            startNext();
        });

        for (const detail of allDetails)
        {
            payload.items[detail.index].details = detail.details;
        }
        detailsCancel?.dispose();
    }

    private createCancellationFromSignal(signal: AbortSignal | undefined): { token: CancellationTokenSource['token']; dispose: () => void } | undefined
    {
        if (!signal)
            return undefined;
        const source = new CancellationTokenSource();
        const onAbort = () =>
        {
            if (!source.token.isCancellationRequested)
                source.cancel();
        };
        if (signal.aborted)
        {
            source.cancel();
        }
        else
        {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const dispose = () =>
        {
            signal.removeEventListener('abort', onAbort);
            source.dispose();
        };
        return { token: source.token, dispose };
    }

    private getExtensionVersion(): string
    {
        try
        {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pkg = require('../../package.json');
            return pkg.version || '0.0.0';
        }
        catch
        {
            return '0.0.0';
        }
    }

    private notifyError(message: string, stopProbing: boolean)
    {
        vscode.window.showErrorMessage(message);
        if (stopProbing)
        {
            this.stopped = true;
            if (this.probeTimer)
            {
                clearTimeout(this.probeTimer);
                this.probeTimer = null;
            }
        }
    }
}
