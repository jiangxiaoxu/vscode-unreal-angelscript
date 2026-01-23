/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import { workspace, ExtensionContext, TextDocument, Range } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { ASDebugSession } from './debug';
import * as Net from 'net';
import { buildSearchPayload, AngelscriptSearchParams, SearchSource, isUnrealConnected, toApiErrorPayload } from './angelscriptApiSearch';
import {
    GetAPIRequest,
    GetAPIDetailsRequest,
    GetAPISearchRequest,
    GetModuleForSymbolRequest,
    GetTypeMembersParams,
    GetTypeMembersRequest,
    GetTypeMembersResult,
    ProvideInlineValuesRequest,
    ResolveSymbolAtPositionParams,
    ResolveSymbolAtPositionRequest,
    ResolveSymbolAtPositionResult,
} from './apiRequests';
import { startMcpHttpServerManager } from './mcpHttpServer';

export function activate(context: ExtensionContext)
{

    // The server is implemented in node
    let serverModule = context.asAbsolutePath(path.join('language-server', 'out', 'server.js'));
    // The debug options for the server
    let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: [{ scheme: 'file', language: 'angelscript' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*.as'),
            configurationSection: "UnrealAngelscript",
        }
    }

    console.log("Activate angelscript extension");

    // Create the language client and start the client.
    let client = new LanguageClient('angelscriptLanguageServer', 'Angelscript Language Server', serverOptions, clientOptions)
    const startedClient = client.start();

    client.onNotification("angelscript/wantSave", (uri: string) =>
    {
        setTimeout(() => vscode.workspace.saveAll(), 100);
    });

    // register a configuration provider for 'mock' debug type
    const provider = new ASConfigurationProvider();
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('angelscript', provider));
    context.subscriptions.push(provider);

    let evaluatableExpressionProvider = new ASEvaluateableExpressionProvider();
    context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('angelscript', evaluatableExpressionProvider));

    // Register 'Go To Symbol'
    let goToSymbol = vscode.commands.registerCommand('angelscript.goToSymbol', (location: any) =>
    {
        vscode.commands.executeCommand("editor.action.goToImplementation", location);
    });

    context.subscriptions.push(goToSymbol);

    let completionParen = vscode.commands.registerCommand('angelscript.paren', () =>
    {
        let activeEditor = vscode.window.activeTextEditor;
        if (activeEditor != null)
        {
            let line_number = activeEditor.selection.active.line;
            let text_line = activeEditor.document.lineAt(line_number);

            let char_number = activeEditor.selection.active.character;
            let char = text_line.text[char_number - 1];

            if (char == '(')
            {
                // Inserted a opening bracket straight away, ignore anything
                return;
            }
            else if (char == '.')
            {
                // Replace the single dot from the commit character with a call
                activeEditor.edit((edit: vscode.TextEditorEdit) =>
                {
                    edit.insert(new vscode.Position(line_number, char_number - 1), "()");
                },
                    {
                        undoStopBefore: false,
                        undoStopAfter: true,
                    });

                // Open suggestions again since the commit character dot did not act as a completion character dot
                vscode.commands.executeCommand('editor.action.triggerSuggest');
            }
            else if (char_number >= text_line.text.length || text_line.text[char_number] != '(')
            {
                let parenConfig = vscode.workspace.getConfiguration("UnrealAngelscript");
                if (!parenConfig.get("insertParenthesisOnFunctionCompletion"))
                    return;

                // There is not an opening paren here, and we are at the end of the line,
                // so we insert a pair of parenthesis
                activeEditor.insertSnippet(new vscode.SnippetString(
                    "($0)"),
                    undefined,
                    {
                        undoStopBefore: false,
                        undoStopAfter: true,
                    });

                // Open signature help popup since we skipped it by not typing the paren
                vscode.commands.executeCommand('editor.action.triggerParameterHints');
            }
        }
    });
    context.subscriptions.push(completionParen);

    let saveAndCreateBlueprint = vscode.commands.registerCommand('angelscript.saveAndCreateBlueprint',
        function (uri: string, className: string)
        {
            let activeEditor = vscode.window.activeTextEditor;
            if (activeEditor != null)
            {
                if (activeEditor.document.isDirty)
                {
                    activeEditor.document.save().then(
                        function (success: boolean)
                        {
                            setTimeout(function ()
                            {
                                vscode.commands.executeCommand('angelscript.createBlueprint', className);
                            }, 300);
                        }
                    );
                }
                else
                {
                    vscode.commands.executeCommand('angelscript.createBlueprint', className);
                }
            }
        });
    context.subscriptions.push(saveAndCreateBlueprint);

    let saveAndEditAsset = vscode.commands.registerCommand('angelscript.saveAndEditAsset',
        function (uri: string, assetPath: string)
        {
            let activeEditor = vscode.window.activeTextEditor;
            if (activeEditor != null)
            {
                if (activeEditor.document.isDirty)
                {
                    activeEditor.document.save().then(
                        function (success: boolean)
                        {
                            setTimeout(function ()
                            {
                                vscode.commands.executeCommand('angelscript.editAsset', assetPath);
                            }, 300);
                        }
                    );
                }
                else
                {
                    vscode.commands.executeCommand('angelscript.editAsset', assetPath);
                }
            }
        });
    context.subscriptions.push(saveAndEditAsset);

    let wrapRegion = vscode.commands.registerCommand('angelscript.wrapRegion', () =>
    {
        let activeEditor = vscode.window.activeTextEditor;
        if (activeEditor != null && activeEditor.document.languageId === 'angelscript')
        {
            let document = activeEditor.document;
            let ranges: vscode.Range[] = [];
            for (let selection of activeEditor.selections)
            {
                let startLine = selection.start.line;
                let endLine = selection.end.line;
                if (!selection.isEmpty && selection.end.character === 0)
                    endLine -= 1;
                if (endLine < startLine)
                    endLine = startLine;

                let startPosition = new vscode.Position(startLine, 0);
                if (selection.isEmpty)
                {
                    ranges.push(new vscode.Range(startPosition, startPosition));
                    continue;
                }

                let endLineText = document.lineAt(endLine).text;
                let endPosition = new vscode.Position(endLine, endLineText.length);
                ranges.push(new vscode.Range(startPosition, endPosition));
            }
            let snippet = new vscode.SnippetString("//#region ${1:Label}\n${TM_SELECTED_TEXT}$0\n//#endregion");
            activeEditor.insertSnippet(snippet, ranges);
        }
    });
    context.subscriptions.push(wrapRegion);

    console.log("Done activating angelscript extension");

    let apiTree = new ASApiTreeProvider(client);
    let apiSearch = new ASApiSearchProvider(client);
    let apiDetails = new ASApiDetailsProvider(client);

    apiSearch.tree = apiTree;

    vscode.window.registerTreeDataProvider("angelscript-api-list", apiTree);
    vscode.window.registerWebviewViewProvider("angelscript-api-search", apiSearch);
    vscode.window.registerWebviewViewProvider("angelscript-api-details", apiDetails);
    vscode.commands.registerCommand("angelscript-api-list.view-details", function (data: any)
    {
        apiDetails.showDetails(data);
    });

    const lm = (vscode as any).lm;
    if (lm?.registerTool)
    {
        const toolDisposable = vscode.lm.registerTool(
            "angelscript_searchApi",
            new AngelscriptSearchApiTool(client, startedClient)
        );
        context.subscriptions.push(toolDisposable);
        const resolveSymbolToolDisposable = vscode.lm.registerTool(
            "angelscript_resolveSymbolAtPosition",
            new AngelscriptResolveSymbolAtPositionTool(client, startedClient)
        );
        context.subscriptions.push(resolveSymbolToolDisposable);
        const getTypeMembersToolDisposable = vscode.lm.registerTool(
            "angelscript_getTypeMembers",
            new AngelscriptGetTypeMembersTool(client, startedClient)
        );
        context.subscriptions.push(getTypeMembersToolDisposable);
    }

    startMcpHttpServerManager(context, client, startedClient);
}

class AngelscriptSearchApiTool implements vscode.LanguageModelTool<AngelscriptSearchParams>
{
    client: LanguageClient;
    startedClient: Promise<void>;

    constructor(client: LanguageClient, startedClient: Promise<void>)
    {
        this.client = client;
        this.startedClient = startedClient;
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<AngelscriptSearchParams>,
        token: CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation>
    {
        const input = options?.input;
        const labelQuery = typeof input?.labelQuery === "string" ? input.labelQuery.trim() : "";
        const searchIndex = Number(input?.searchIndex);
        const maxBatchResults = typeof input?.maxBatchResults === "number" ? input.maxBatchResults : undefined;
        const includeDocs = input?.includeDocs === true ? "true" : "false";
        const labelQueryUseRegex = input?.labelQueryUseRegex === true ? "true" : "false";
        const signatureRegex = typeof input?.signatureRegex === "string" ? input.signatureRegex.trim() : "";
        const source = typeof input?.source === "string" ? input.source : "both";
        const kinds = Array.isArray(input?.kinds) ? input?.kinds.filter((item) => typeof item === "string") : [];

        const details: string[] = [];
        details.push(`source=${source}`);
        if (Number.isFinite(searchIndex))
            details.push(`index=${searchIndex}`);
        if (typeof maxBatchResults === "number")
            details.push(`max=${maxBatchResults}`);
        details.push(`docs=${includeDocs}`);
        details.push(`labelRegex=${labelQueryUseRegex}`);
        if (signatureRegex)
            details.push(`signatureRegex=${signatureRegex}`);
        if (kinds && kinds.length > 0)
            details.push(`kinds=${kinds.join(",")}`);

        const queryLabel = labelQuery ? `"${labelQuery}"` : "<empty>";
        return {
            invocationMessage: `Search Angelscript API ${queryLabel} (${details.join(", ")})`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AngelscriptSearchParams>,
        token: CancellationToken
    ): Promise<vscode.LanguageModelToolResult>
    {
        const searchIndex = Number(options?.input?.searchIndex);
        const labelQuery = typeof options?.input?.labelQuery === "string" ? options.input.labelQuery.trim() : "";
        if (!labelQuery)
        {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    ok: false,
                    error: {
                        code: "MISSING_LABEL_QUERY",
                        message: "Missing labelQuery. Please provide labelQuery."
                    }
                }, null, 2))
            ]);
        }
        const maxBatchResults = options?.input?.maxBatchResults;

        try
        {
            await this.startedClient;
            const isConnected = await isUnrealConnected(this.client);
            if (!isConnected)
            {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        JSON.stringify({
                            ok: false,
                            error: {
                                code: "UE_UNAVAILABLE",
                                message: "Unable to connect to the UE5 engine; the angelscript_searchApi tool is unavailable."
                            }
                        }, null, 2)
                    )
                ]);
            }
            const payload = await buildSearchPayload(
                this.client,
                {
                    labelQuery,
                    searchIndex,
                    maxBatchResults: maxBatchResults,
                    includeDocs: options?.input?.includeDocs,
                    kinds: options?.input?.kinds,
                    source: options?.input?.source,
                    labelQueryUseRegex: options?.input?.labelQueryUseRegex,
                    signatureRegex: options?.input?.signatureRegex
                },
                () => token.isCancellationRequested
            );

            if (payload.items.length === 0)
            {
                const request: Record<string, unknown> = {
                    labelQuery,
                    searchIndex,
                    maxBatchResults: maxBatchResults ?? 200,
                    kinds: options?.input?.kinds,
                    source: options?.input?.source ?? "both",
                    labelQueryUseRegex: options?.input?.labelQueryUseRegex === true,
                };
                const signatureRegex = typeof options?.input?.signatureRegex === "string"
                    ? options.input.signatureRegex.trim()
                    : "";
                if (signatureRegex)
                {
                    request.signatureRegex = signatureRegex;
                }
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify({
                        ...payload,
                        text: `No Angelscript API results for "${labelQuery}".`,
                        request
                    }, null, 2))
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
            ]);
        }
        catch (error)
        {
            const apiError = toApiErrorPayload(error);
            if (apiError)
            {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(apiError, null, 2))
                ]);
            }
            console.error("angelscript_searchApi tool failed:", error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    JSON.stringify({
                        ok: false,
                        error: {
                            code: "INTERNAL_ERROR",
                            message: "The Angelscript API tool failed to run. Please ensure the language server is running and try again."
                        }
                    }, null, 2)
                )
            ]);
        }
    }
}

class AngelscriptResolveSymbolAtPositionTool implements vscode.LanguageModelTool<ResolveSymbolAtPositionParams>
{
    client: LanguageClient;
    startedClient: Promise<void>;

    constructor(client: LanguageClient, startedClient: Promise<void>)
    {
        this.client = client;
        this.startedClient = startedClient;
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ResolveSymbolAtPositionParams>,
        token: CancellationToken
    ): Promise<vscode.LanguageModelToolResult>
    {
        const input = options?.input;
        const uri = input?.uri;
        const position = input?.position;
        const line = position?.line;
        const character = position?.character;

        if (typeof uri !== "string" || typeof line !== "number" || typeof character !== "number")
        {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    ok: false,
                    error: {
                        code: "InvalidParams",
                        message: "Invalid params. Provide uri and position { line, character }."
                    }
                }, null, 2))
            ]);
        }

        const includeDocumentation = input?.includeDocumentation !== false;

        try
        {
            await this.startedClient;
            const result = await this.client.sendRequest(
                ResolveSymbolAtPositionRequest,
                {
                    uri,
                    position: { line, character },
                    includeDocumentation,
                }
            ) as ResolveSymbolAtPositionResult;

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
            ]);
        }
        catch (error)
        {
            console.error("angelscript_resolveSymbolAtPosition tool failed:", error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    JSON.stringify({
                        ok: false,
                        error: {
                            code: "INTERNAL_ERROR",
                            message: "The resolveSymbolAtPosition tool failed to run. Please ensure the language server is running and try again."
                        }
                    }, null, 2)
                )
            ]);
        }
    }
}

class AngelscriptGetTypeMembersTool implements vscode.LanguageModelTool<GetTypeMembersParams>
{
    client: LanguageClient;
    startedClient: Promise<void>;

    constructor(client: LanguageClient, startedClient: Promise<void>)
    {
        this.client = client;
        this.startedClient = startedClient;
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetTypeMembersParams>,
        token: CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation>
    {
        const input = options?.input;
        const name = typeof input?.name === "string" ? input.name.trim() : "";
        const namespace = typeof input?.namespace === "string" ? input.namespace.trim() : "";
        const includeInherited = input?.includeInherited === true ? "true" : "false";
        const includeDocs = input?.includeDocs === true ? "true" : "false";
        const kinds = typeof input?.kinds === "string" ? input.kinds.trim() : "both";
        const details: string[] = [];
        if (namespace)
            details.push(`namespace=${namespace}`);
        details.push(`includeInherited=${includeInherited}`);
        details.push(`includeDocs=${includeDocs}`);
        details.push(`kinds=${kinds || "both"}`);
        const label = name ? `"${name}"` : "<empty>";
        return {
            invocationMessage: `Get Angelscript type members ${label} (${details.join(", ")})`
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTypeMembersParams>,
        token: CancellationToken
    ): Promise<vscode.LanguageModelToolResult>
    {
        const input = options?.input;
        const name = typeof input?.name === "string" ? input.name.trim() : "";
        if (!name)
        {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    ok: false,
                    error: {
                        code: "InvalidParams",
                        message: "Invalid params. 'name' must be a non-empty string."
                    }
                }, null, 2))
            ]);
        }

        const namespace = typeof input?.namespace === "string" ? input.namespace.trim() : undefined;
        const includeInherited = input?.includeInherited === true;
        const includeDocs = input?.includeDocs === true;
        const kinds = typeof input?.kinds === "string" ? input.kinds.trim() : undefined;

        try
        {
            await this.startedClient;
            const isConnected = await isUnrealConnected(this.client);
            if (!isConnected)
            {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        JSON.stringify({
                            ok: false,
                            error: {
                                code: "UE_UNAVAILABLE",
                                message: "Unable to connect to the UE5 engine; the angelscript_getTypeMembers tool is unavailable."
                            }
                        }, null, 2)
                    )
                ]);
            }

            const result = await this.client.sendRequest<GetTypeMembersResult>(
                GetTypeMembersRequest.method,
                {
                    name,
                    namespace,
                    includeInherited,
                    includeDocs,
                    kinds,
                }
            ) as GetTypeMembersResult;

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
            ]);
        }
        catch (error)
        {
            console.error("angelscript_getTypeMembers tool failed:", error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    JSON.stringify({
                        ok: false,
                        error: {
                            code: "INTERNAL_ERROR",
                            message: "The angelscript_getTypeMembers tool failed to run. Please ensure the language server is running and try again."
                        }
                    }, null, 2)
                )
            ]);
        }
    }
}

class ASApiSearchProvider implements vscode.WebviewViewProvider
{
    webview: vscode.Webview;
    client: LanguageClient;
    searchHtml: string;
    tree: ASApiTreeProvider;

    constructor(client: LanguageClient)
    {
        this.client = client;
        this.searchHtml = `
        <style>
        .api-search-toolbar {
            display: flex;
            gap: 12px;
            align-items: center;
            margin-bottom: 8px;
            font-size: 90%;
        }
        .api-search-tabs {
            display: inline-flex;
            gap: 16px;
            align-items: flex-end;
            border-bottom: 1px solid var(--vscode-editorWidget-border, #808080);
            padding-bottom: 2px;
        }
        .api-search-tab {
            background: transparent;
            border: none;
            color: var(--vscode-descriptionForeground, #7a7a7a);
            cursor: pointer;
            padding: 4px 0 6px 0;
            font-size: 105%;
            font-weight: 500;
            opacity: 0.65;
            border-bottom: 2px solid transparent;
        }
        .api-search-tab[aria-selected="true"] {
            opacity: 1;
            color: var(--vscode-foreground, #d4d4d4);
            border-bottom-color: var(--vscode-textLink-foreground, #3794ff);
        }
        </style>

        <div class="api-search-toolbar" role="tablist" aria-label="Search source">
            <div class="api-search-tabs">
                <button class="api-search-tab" type="button" data-source="native" role="tab" aria-selected="false">Native</button>
                <button class="api-search-tab" type="button" data-source="script" role="tab" aria-selected="false">Script</button>
                <button class="api-search-tab" type="button" data-source="both" role="tab" aria-selected="true">Both</button>
            </div>
        </div>
        <input
            id="search"
            type="text"
            style="width: 100%; display: block; padding: 5px; font-size: 130%; background: inherit; border: 1px solid gray; color: inherit;"
            placeholder="Search Angelscript API"
        />

        <script>
        let vscode = acquireVsCodeApi();
        let searchBox = document.getElementById("search");
        let sourceTabs = Array.from(document.querySelectorAll(".api-search-tab"));
        let currentSource = "both";
        let isValidSource = function(value) {
            return value === "native" || value === "script" || value === "both";
        };
        let setSelectedSource = function(value) {
            sourceTabs.forEach((tab) => {
                let tabSource = tab.getAttribute("data-source");
                tab.setAttribute("aria-selected", tabSource === value ? "true" : "false");
            });
        };
        let state = vscode.getState();
        if (state && typeof state.source === "string" && isValidSource(state.source))
        {
            currentSource = state.source;
            setSelectedSource(currentSource);
            vscode.postMessage({
                search: searchBox.value,
                source: currentSource
            });
        }
        let getSelectedSource = function() {
            let selected = sourceTabs.find((tab) => tab.getAttribute("aria-selected") === "true");
            return selected ? selected.getAttribute("data-source") : "both";
        };
        searchBox.addEventListener("input", function()
        {
            vscode.postMessage({
                search: searchBox.value,
                source: getSelectedSource()
            });
        });
        sourceTabs.forEach((tab) => {
            tab.addEventListener("click", function() {
                let nextSource = tab.getAttribute("data-source") || "both";
                if (nextSource === currentSource)
                    return;
                sourceTabs.forEach((other) => other.setAttribute("aria-selected", "false"));
                tab.setAttribute("aria-selected", "true");
                currentSource = nextSource;
                vscode.setState({ source: currentSource });
                vscode.postMessage({
                    search: searchBox.value,
                    source: currentSource
                });
            });
        });
        window.addEventListener("focus", function(event)
        {
            searchBox.focus();
        });
        </script>
    `;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: CancellationToken): Thenable<void> | void
    {
        this.webview = webviewView.webview;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.searchHtml;
        this.tree.searchSource = "both";

        let searchProvider = this;
        webviewView.webview.onDidReceiveMessage(function (data: any)
        {
            searchProvider.onMessage(data);
        });
    }

    onMessage(data: any)
    {
        if (data && typeof data === "object" && typeof data.search === "string")
        {
            this.tree.search = data.search;
            if (data.source === "native" || data.source === "script" || data.source === "both")
                this.tree.searchSource = data.source;
            else
                this.tree.searchSource = "both";
        }
        else
        {
            this.tree.search = data as string;
            this.tree.searchSource = "both";
        }
        this.tree.refresh();
    }
}

class ASApiDetailsProvider implements vscode.WebviewViewProvider
{
    webview: vscode.Webview;
    client: LanguageClient;

    constructor(client: LanguageClient)
    {
        this.client = client;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: CancellationToken): Thenable<void> | void
    {
        this.webview = webviewView.webview;
        webviewView.webview.html = "<em>Select API to see details...</em>";
    }

    showDetails(data: any)
    {
        let webview = this.webview;
        this.client.sendRequest(GetAPIDetailsRequest, data).then(
            async function (details: string)
            {
                let detailsHtml = await vscode.commands.executeCommand("markdown.api.render", details) as string;
                detailsHtml = `
                <style>
                body {
                    font-size: 100%;
                }
                pre {
                    font-size: 110%;
                    white-space: pre-wrap;
                    tab-size: 2;
                    background: none;
                }
                pre > code {
                    background: none;
                }
                </style>

                <div style="width: 100%; overflow: wrap;">
                ${detailsHtml}
                </div>
`;
                webview.html = detailsHtml;
            }
        );
    }
}

class ASApiTreeProvider implements vscode.TreeDataProvider<ASApiItem>
{
    client: LanguageClient;
    search: string;
    searchSource: SearchSource = "both";

    private _onDidChangeTreeData: vscode.EventEmitter<ASApiItem | undefined | void> = new vscode.EventEmitter<ASApiItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ASApiItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(client: LanguageClient)
    {
        this.client = client;
    }

    refresh()
    {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ASApiItem)
    {
        return element;
    }

    getChildren(element?: ASApiItem): Thenable<ASApiItem[]>
    {
        let request;
        if (element)
            request = this.client.sendRequest(GetAPIRequest, element.id);
        else if (this.search)
            request = this.client.sendRequest(GetAPISearchRequest, {
                filter: this.search,
                source: this.searchSource
            });
        else
            request = this.client.sendRequest(GetAPIRequest, "");

        return request.then(
            function (values: any[])
            {
                let items = new Array<ASApiItem>();
                for (let api of values)
                {
                    if (api.type == "namespace")
                    {
                        // In case of nested namespaces, only take the rightmost namespace name as a label
                        let label: string = api.label;
                        if (label.indexOf("::") != -1)
                        {
                            let parts = label.split("::");
                            label = parts[parts.length - 2] + "::";
                        }
                        let item = new ASApiItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                        item.type = api.type;
                        item.data = api.data;
                        item.id = `__ns_${api.id}`;
                        item.iconPath = new vscode.ThemeIcon("symbol-namespace", new vscode.ThemeColor("terminal.ansiBrightBlue"));
                        items.push(item);
                    }
                    else if (api.type == "type")
                    {
                        let item = new ASApiItem(api.label);
                        item.id = `__type_${api.id}`;
                        item.data = api.data;
                        item.type = api.type;
                        item.command = {
                            "title": "View Details",
                            "command": "angelscript-api-list.view-details",
                            "arguments": [api.data],
                        };
                        let typeColor = new vscode.ThemeColor("charts.cyan");
                        let typeIcon = "symbol-class";
                        if (Array.isArray(api.data) && api.data[0] == "type")
                        {
                            let typeKind = api.data[3] as string;
                            if (typeKind == "enum")
                                typeIcon = "symbol-enum";
                            else if (typeKind == "struct")
                                typeIcon = "symbol-struct";
                        }
                        item.iconPath = new vscode.ThemeIcon(typeIcon, typeColor);
                        items.push(item);
                    }
                    else if (api.type == "function")
                    {
                        let item = new ASApiItem(api.label);
                        item.id = `__fun_${api.id}`;
                        item.data = api.data;
                        item.type = api.type;
                        let isConstructor = typeof api.label === "string" && api.label.startsWith("<ctor>");
                        item.command = {
                            "title": "View Details",
                            "command": "angelscript-api-list.view-details",
                            "arguments": [api.data],
                        };
                        item.iconPath = new vscode.ThemeIcon(
                            isConstructor ? "symbol-constructor" : "symbol-function",
                            new vscode.ThemeColor(isConstructor ? "charts.orange" : "terminal.ansiBrightYellow")
                        );
                        items.push(item);
                    }
                    else if (api.type == "property")
                    {
                        let item = new ASApiItem(api.label);
                        item.id = `__prop_${api.id}`;
                        item.data = api.data;
                        item.type = api.type;
                        item.command = {
                            "title": "View Details",
                            "command": "angelscript-api-list.view-details",
                            "arguments": [api.data],
                        };
                        item.iconPath = new vscode.ThemeIcon("symbol-field", new vscode.ThemeColor("terminal.ansiBrightCyan"));
                        items.push(item);
                    }
                }

                return items;
            }
        );
    }

    resolveTreeItem(item: vscode.TreeItem, element: ASApiItem, token: CancellationToken): ProviderResult<vscode.TreeItem>
    {
        return this.client.sendRequest(GetAPIDetailsRequest, element.data).then(
            function (details: string)
            {
                element.tooltip = new vscode.MarkdownString(details);
                element.tooltip.supportHtml = true;
                return element;
            }
        );
    }
}

class ASApiItem extends vscode.TreeItem
{
    type: string;
    data: any;
}


class ASConfigurationProvider implements vscode.DebugConfigurationProvider
{

    private _server?: Net.Server;
    private _config?: DebugConfiguration;

    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration>
    {
        if (!config.type && !config.request && !config.name)
        {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'angelscript')
            {
                config.type = 'angelscript';
                config.name = 'Debug Angelscript';
                config.request = 'launch';
                config.stopOnEntry = true;
            }
        }

        let port = config.port;
        let hostname = config.hostname;

        // start port listener on launch of first debug session
        // or if the port changed
        if (!this._server || (this._server && (port != this._config.port || hostname != this._config.hostname)))
        {
            // start listening on a random port
            this._server = Net.createServer(socket =>
            {
                const session = new ASDebugSession();
                session.setRunAsServer(true);

                if (port !== undefined && port > 0)
                {
                    // Use the provided port
                    session.port = port;
                }
                else
                {
                    // Get the port from the workspace configuration
                    session.port = vscode.workspace.getConfiguration("UnrealAngelscript").get("unrealConnectionPort");
                }

                if (hostname !== undefined)
                {
                    session.hostname = hostname;
                }

                session.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }

        // make VS Code connect to debug server instead of launching debug adapter
        config.debugServer = (this._server.address() as Net.AddressInfo).port;

        this._config = config;
        return config;
    }

    dispose()
    {
        if (this._server)
        {
            this._server.close();
        }
    }
}

class ASEvaluateableExpressionProvider implements vscode.EvaluatableExpressionProvider
{
    provideEvaluatableExpression(document: TextDocument, position: vscode.Position, token: CancellationToken): ProviderResult<vscode.EvaluatableExpression>
    {
        let lineContent = document.lineAt(position.line).text;

        // Search backward until we find a character that makes us want to stop
        let start = position.character;
        let depth = 0;
        while (start > 0)
        {
            let stop = false;
            switch (lineContent[start])
            {
                case '(':
                case ')':
                case '{':
                case '}':
                case '<':
                case '>':
                case ' ':
                case '\t':
                case '\n':
                case '\r':
                case '+':
                case '-':
                case '/':
                case '%':
                case '~':
                case '#':
                case '^':
                case ';':
                case '=':
                case '|':
                case ',':
                case '`':
                case '!':
                case '\\':
                    if (depth == 0)
                    {
                        stop = true;
                    }
                    break;
                case ']':
                    if (start + 1 < lineContent.length && lineContent[start + 1] == '.')
                    {
                        depth += 1;
                    }
                    else
                    {
                        stop = true;
                    }
                    break;
                case '[':
                    if (depth == 0)
                    {
                        stop = true;
                    }
                    else
                    {
                        depth -= 1;
                    }
                    break;
            }

            if (stop)
            {
                start += 1;
                break;
            }
            else
            {
                start -= 1;
            }
        }

        // Complete the word after the cursor
        let end = position.character;
        while (end < lineContent.length)
        {
            let charCode = lineContent.charCodeAt(end);
            if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || (charCode >= 48 && charCode <= 57) || charCode == 95)
            {
                end += 1;
                continue;
            }
            else
            {
                break;
            }
        }

        if (start >= end)
        {
            return null;
        }
        else
        {
            return new vscode.EvaluatableExpression(
                new vscode.Range(
                    new vscode.Position(position.line, start),
                    new vscode.Position(position.line, end),
                )
            );
        }
    }
};
