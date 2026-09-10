'use strict';

import {
    IPCMessageReader, IPCMessageWriter, StreamMessageReader, StreamMessageWriter, createConnection, Connection, TextDocuments,
    Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem,
    CompletionItemKind, SignatureHelp, Hover, DocumentSymbolParams, SymbolInformation,
    WorkspaceSymbolParams, Definition, ExecuteCommandParams, VersionedTextDocumentIdentifier, Location,
    TextDocumentSyncKind, SemanticTokensOptions, SemanticTokensLegend,
    SemanticTokensParams, SemanticTokens, SemanticTokensBuilder, ReferenceOptions, ReferenceParams,
    CodeLens, CodeLensParams, DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, DidOpenTextDocumentParams,
    RenameParams, WorkspaceEdit, ResponseError, PrepareRenameParams, Range, Position, Command, SemanticTokensDeltaParams,
    SemanticTokensDelta, TextDocumentItem,
    CodeActionParams,
    CodeAction,
    DidCloseTextDocumentParams,
    FileChangeType,
    DidChangeConfigurationParams, TextEdit,
    DocumentColorRegistrationOptions, DocumentColorParams, ColorInformation,
    ColorPresentationParams, ColorPresentation,
    TypeHierarchyItem, TypeHierarchyPrepareParams,
    TypeHierarchySupertypesParams, TypeHierarchySubtypesParams,
    WorkspaceSymbol, DocumentSymbol,
    InlayHint, InlayHintParams,
    InlineValue, InlineValueParams, WorkspaceFolder,
} from 'vscode-languageserver/node';
import { TextDocument, TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument';

import { Socket } from 'net';
import { URI } from 'vscode-uri'
import { randomUUID } from 'node:crypto';

import * as scriptfiles from './as_parser';
import * as parsedcompletion from './parsed_completion';
import * as typedb from './database';
import * as scriptreferences from './references';
import * as scriptoccurances from './highlight_occurances';
import * as scriptsemantics from './semantic_highlighting';
import * as scriptsymbols from './symbols';
import * as scriptdiagnostics from './ls_diagnostics';
import * as scriptlenses from './code_lenses';
import * as scriptactions from './code_actions';
import * as generatedcode from './generated_code';
import * as assets from './assets';
import * as inlayhints from './inlay_hints';
import * as inlinevalues from './inline_values';
import * as colorpicker from './color_picker';
import * as typehierarchy from './type_hierarchy';
import { registerApiRequestHandlers } from './apiRequestHandlers';
import * as workspaceLayout from './workspaceLayout';
import { resolveLanguageServerInitializationOptions, ResolvedAngelScriptLanguageServerOptions } from './languageServerContract';
import { createLanguageServerAutomationRuntime } from './languageServerAutomationRuntime';
import { createActiveWorkTracker } from './activeWorkTracker';
import { verifyEditorListenerIdentity, verifyEstablishedEditorConnectionIdentity } from './editorListenerIdentity';
import { createConnectionAttemptFence } from './connectionAttemptFence';
import { createPerSocketRequestScheduler } from './perSocketRequestScheduler';
import { LANGUAGE_SERVER_TIMEOUTS_MS } from './languageServerTimeouts';
import { createUnrealReconnectScheduler } from './unrealReconnectScheduler';
import {
    createProjectDaemonScriptSnapshotProtocol,
    ScriptSnapshotChange,
    ValidatedScriptSnapshotContent,
} from './scriptSnapshotProtocol';
import { ScriptSnapshotIdentity } from './scriptSnapshotSequence';
import { createScriptSnapshotFileManifestValidator } from './scriptSnapshotFileManifest';
import glob from 'glob';

const ExtensionVersion = String(require('../../package.json').version);

import {
    Message, MessageType, UnrealMessageDecoder, buildGoTo,
    buildDisconnect, buildOpenAssets, buildCreateBlueprint,
    buildLegacyRequestDebugDatabase,
    readDebugDatabaseAccessFrame, readDebugDatabaseAccessFinishedFrame,
} from './unreal-buffers';

// Create a connection for the server.
//
// If we have a Node IPC send function available, use that, otherwise use stdio
// to be used as a standalone lsp client.
const ipcSendAvailble = typeof process.send === 'function';
let connection: Connection = ipcSendAvailble
    ? createConnection(new IPCMessageReader(process), new IPCMessageWriter(process))
    : createConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));

// Create a connection to unreal
let unreal : Socket;
const requestDebugDatabaseScheduler = createPerSocketRequestScheduler<Socket>();

const hostname = "127.0.0.1";
let port : number = 27099;

let ParseQueue : Array<scriptfiles.ASModule> = [];
let ParseQueueIndex = 0;
let LoadQueue : Array<scriptfiles.ASModule> = [];
let LoadQueueIndex = 0;
let PostProcessTypesQueue : Array<scriptfiles.ASModule> = [];
let PostProcessTypesQueueIndex = 0;
let ResolveQueue : Array<scriptfiles.ASModule> = [];
let ResolveQueueIndex = 0;
let IsServicingQueues = false;

let ReceivingTypesTimeout : any = null;
let UnrealSocketEpoch = 0;
let SetTypeTimeout = false;
let UnrealTypesTimedOut = false;
let UnrealConnected = false;
let CacheRootPath : string = null;
let PendingReResolveAfterInitialParse = false;
let PendingNativeDiagnosticsGeneration: number | null = null;
let ActiveNativeDiagnosticsCancel: (() => void) | null = null;
let SemanticTokensRefreshTimeout : any = null;
let PendingSemanticModules = new Set<scriptfiles.ASModule>();

let settings : any = null;
const connectAttemptFence = createConnectionAttemptFence();
let LanguageServerStopping = false;
let LanguageServerShutdownPromise: Promise<boolean> | null = null;
let ParentProcessWatch: NodeJS.Timeout | null = null;
let InitialUnrealConnectionClassificationTimeout: NodeJS.Timeout | null = null;
let LanguageServerOptions : ResolvedAngelScriptLanguageServerOptions | null = null;
const automationRuntime = createLanguageServerAutomationRuntime(connection, ExtensionVersion);
const unrealCacheController = automationRuntime.cache;
const readinessController = automationRuntime.readiness;
const ProjectDaemonServerInstanceId = randomUUID();
const scriptSnapshotFileManifestValidator = createScriptSnapshotFileManifestValidator();
const projectDaemonScriptSnapshotProtocol = createProjectDaemonScriptSnapshotProtocol({
    connection,
    serverInstanceId: ProjectDaemonServerInstanceId,
    isEnabled: () => LanguageServerOptions?.role == 'project-daemon',
    getReadiness: () => readinessController.snapshot(),
    validateSnapshotUri: (uri) => IsScriptUri(uri),
    validateSnapshotContent: (...args) => scriptSnapshotFileManifestValidator.validate(...args),
    applyAcceptedSnapshot: ApplyAcceptedScriptSnapshot,
    getDiagnostics: () => automationRuntime.getWorkspaceDiagnosticsReport(),
});
const reResolveWork = createActiveWorkTracker(TrySettleSemanticGeneration);
const unrealReconnectScheduler = createUnrealReconnectScheduler(
    () => void connect_unreal(),
    () => !LanguageServerStopping && !!LanguageServerOptions?.unrealOnline,
);

function resumeRestoredNativeDiagnosticsIfNeeded() : void
{
    let activeGeneration = unrealCacheController.getActiveGeneration();
    if (activeGeneration === undefined
        || readinessController.snapshot().stage != 'resolving'
        || PendingNativeDiagnosticsGeneration != null
        || ActiveNativeDiagnosticsCancel)
        return;
    automationRuntime.resumeNativeDiagnostics(activeGeneration);
    ScheduleNativeDiagnosticsRefresh(activeGeneration);
}

function watchProjectDaemonParent(processId: number | null) : void
{
    if (!Number.isSafeInteger(processId) || processId! <= 0)
        throw new Error("Role 'project-daemon' requires initialize.processId.");
    if (ParentProcessWatch)
        clearInterval(ParentProcessWatch);
    ParentProcessWatch = setInterval(() => {
        try { process.kill(processId!, 0); }
        catch
        {
            void stopLanguageServerResources().finally(() => process.exit(0));
        }
    }, LANGUAGE_SERVER_TIMEOUTS_MS.parentProcessWatchdog);
    ParentProcessWatch.unref();
}

function schedule_unreal_reconnect() : void
{
    unrealReconnectScheduler.schedule();
}

async function connect_unreal() : Promise<void>
{
    if (LanguageServerStopping || !LanguageServerOptions?.unrealOnline || connectAttemptFence.hasActive())
        return;
    let attemptOptions = LanguageServerOptions;
    let attempt = connectAttemptFence.begin();
    let isCurrentAttempt = () => !LanguageServerStopping
        && LanguageServerOptions === attemptOptions
        && attemptOptions.unrealOnline
        && connectAttemptFence.isCurrent(attempt);
    // connection.console.log('Connecting to unreal editor on port '+port);

    unrealReconnectScheduler.cancel();

    if (!LanguageServerOptions.uprojectPath)
    {
        connectAttemptFence.complete(attempt);
        connection.console.error('Unreal connection refused: exact uprojectPath is unavailable.');
        schedule_unreal_reconnect();
        return;
    }
    let preflight = await verifyEditorListenerIdentity({
        port,
        uprojectPath: attemptOptions.uprojectPath,
    });
    if (!isCurrentAttempt())
        return;
    if (preflight.ok === false)
    {
        connectAttemptFence.complete(attempt);
        readinessController.update({
            unrealConnected: false,
            editorProcessId: undefined,
            editorIdentityVerification: preflight.code == 'unsupported-platform' ? 'unsupported-platform' : 'rejected',
        });
        connection.console.warn(preflight.reason);
        if (preflight.code != 'unsupported-platform')
            schedule_unreal_reconnect();
        return;
    }

    if (unreal != null)
    {
        requestDebugDatabaseScheduler.cancel(unreal);
        unreal.removeAllListeners();
        unreal.write(Uint8Array.from(buildDisconnect()));
        unreal.destroy();
    }
    UnrealConnected = false;
    let connectingSocket = new Socket;
    UnrealSocketEpoch += 1;
    let messageDecoder = new UnrealMessageDecoder();
    unreal = connectingSocket;

    connectingSocket.on("data", function(data : Buffer) {
        if (unreal !== connectingSocket)
            return;
        let messages : Array<Message> = messageDecoder.push(data);
        for (let msg of messages)
        {
            if (msg.type == MessageType.Diagnostics)
            {
                let diagnostics: Diagnostic[] = [];

                // Based on https://en.wikipedia.org/wiki/File_URI_scheme,
                // file:/// should be on both platforms, but on Linux the path
                // begins with / while on Windows it is omitted. So we need to
                // add it here to make sure both platforms are valid.
                let localpath = msg.readString();
                let filename = (localpath[0] == '/') ? ("file://" + localpath) : ("file:///" + localpath);
                //connection.console.log('Diagnostics received: '+filename);

                let msgCount = msg.readInt();
                for (let i = 0; i < msgCount; ++i)
                {
                    let message = msg.readString();
                    let line = msg.readInt();
                    let char = msg.readInt();
                    let isError = msg.readBool();
                    let isInfo = msg.readBool();

                    if (isInfo)
                    {
                        let hasExisting : boolean = false;
                        for(let diag of diagnostics)
                        {
                            if (diag.range.start.line == line-1)
                                hasExisting = true;
                        }

                        if(!hasExisting)
                            continue;
                    }

                    if (line <= 0)
                        line = 1;

                    let diagnosic: Diagnostic = {
                        severity: isInfo ? DiagnosticSeverity.Information : (isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning),
                        range: {
                            start: { line: line-1, character: 0 },
                            end: { line: line-1, character: 10000 }
                        },
                        message: message,
                        source: 'as'
                    };
                    diagnostics.push(diagnosic);
                }

                scriptdiagnostics.UpdateCompileDiagnostics(filename, diagnostics);
            }
            else if(msg.type == MessageType.DebugDatabase)
            {
                if (!unrealCacheController.isRefreshInProgress())
                    continue;
                let dbStr = msg.readString();
                let dbObj = JSON.parse(dbStr);
                unrealCacheController.recordDebugDatabaseChunk(dbObj);

                UnrealTypesTimedOut = false;
                ArmDebugDatabaseStreamTimeout();
            }
            else if(msg.type == MessageType.DebugDatabaseFinished)
            {
                if (!unrealCacheController.isRefreshInProgress())
                    continue;
                if (ReceivingTypesTimeout)
                    clearTimeout(ReceivingTypesTimeout);
                ReceivingTypesTimeout = null;
                CommitLegacyDebugDatabaseBase(connectingSocket, UnrealSocketEpoch);
            }
            else if(msg.type == MessageType.DebugDatabaseAccessBegin)
            {
                if (!unrealCacheController.isRefreshInProgress())
                    continue;
                if (msg.remainingSize != 0)
                {
                    connection.console.error('DebugDatabase access sidecar begin contains an unsupported payload.');
                    unrealCacheController.discardDebugDatabaseAccessChunks();
                    continue;
                }
                unrealCacheController.setDebugDatabaseAccessExpected(true);
                ArmDebugDatabaseStreamTimeout();
            }
            else if(msg.type == MessageType.DebugDatabaseAccess)
            {
                if (!unrealCacheController.isRefreshInProgress()
                    || unrealCacheController.getDebugDatabaseAccessReadiness() != 'pending')
                    continue;
                try
                {
                    let frame = readDebugDatabaseAccessFrame(msg);
                    let sidecar = JSON.parse(frame.payload ?? '');
                    unrealCacheController.recordDebugDatabaseAccessChunk(sidecar);
                    ArmDebugDatabaseStreamTimeout();
                }
                catch (error)
                {
                    connection.console.error(`DebugDatabase access sidecar ignored: ${String(error)}`);
                    unrealCacheController.discardDebugDatabaseAccessChunks();
                }
            }
            else if(msg.type == MessageType.DebugDatabaseAccessFinished)
            {
                if (!unrealCacheController.isRefreshInProgress()
                    || unrealCacheController.getDebugDatabaseAccessReadiness() != 'pending')
                    continue;
                try
                {
                    readDebugDatabaseAccessFinishedFrame(msg);
                    unrealCacheController.finishDebugDatabaseAccess();
                    ArmDebugDatabaseStreamTimeout();
                }
                catch (error)
                {
                    connection.console.error(`DebugDatabase access completion ignored: ${String(error)}`);
                    unrealCacheController.discardDebugDatabaseAccessChunks();
                }
            }
            else if(msg.type == MessageType.AssetDatabase)
            {
                let version = msg.readInt();
                if (version == 1)
                {
                    let assetCount = msg.readInt();
                    for (let i = 0; i < assetCount; i += 2)
                    {
                        let assetPath = msg.readString();
                        let className = msg.readString();

                        if (className.length == 0)
                            assets.RemoveAsset(assetPath);
                        else
                            assets.AddAsset(assetPath, className);
                    }
                }
            }
            else if(msg.type == MessageType.AssetDatabaseInit)
            {
                // Remove all old asset info from the database, we're receiving new stuff
                assets.ClearDatabase();
            }
            else if(msg.type == MessageType.DebugDatabaseSettings)
            {
                automationRuntime.beginLiveRefresh();
                projectDaemonScriptSnapshotProtocol.markSemanticUnsettled();
                PendingNativeDiagnosticsGeneration = null;
                ActiveNativeDiagnosticsCancel?.();
                let version = msg.readInt();

                let pendingSettings: Record<string, boolean> = {};
                /* automaticImports = */ msg.readBool(); // Unused, non-automatic imports are no longer supported

                if (version >= 2)
                    pendingSettings.floatIsFloat64 = msg.readBool();
                if (version >= 3)
                    pendingSettings.useAngelscriptHaze = msg.readBool();
                if (version >= 5)
                {
                    pendingSettings.deprecateStaticClass = msg.readBool();
                    pendingSettings.disallowStaticClass = msg.readBool();
                }
                if (version >= 6)
                {
                    pendingSettings.exposeGlobalFunctions = msg.readBool();
                }
                if (version >= 7)
                {
                    pendingSettings.deprecateActorGenerics = msg.readBool();
                    pendingSettings.disallowActorGenerics = msg.readBool();
                }
                unrealCacheController.recordDebugDatabaseSettings(pendingSettings, version >= 4, false);
                ArmDebugDatabaseStreamTimeout();
            }
            else if(msg.type == MessageType.ReplaceAssetDefinition)
            {
                let assetName = msg.readString();
                let lineCount = msg.readInt();
                let lines : Array<string> = [];
                for (let i = 0; i < lineCount; i += 1)
                    lines.push(msg.readString());

                ReplaceScriptAssetDefinition(assetName, lines);
            }
        }
    });

    connectingSocket.on("error", function() {
        requestDebugDatabaseScheduler.cancel(connectingSocket);
        // connection.console.log('Reconnecting to unreal due to error');
        if (unreal === connectingSocket)
        {
            connectingSocket.destroy();
            unreal = null;
            connectAttemptFence.complete(attempt);
            UnrealConnected = false;
            if (ReceivingTypesTimeout)
            {
                clearTimeout(ReceivingTypesTimeout);
                ReceivingTypesTimeout = null;
            }
            automationRuntime.abortLiveRefresh('Unreal TCP connection failed.');
            resumeRestoredNativeDiagnosticsIfNeeded();
            readinessController.update({ unrealConnected: false, editorProcessId: undefined, editorIdentityVerification: 'pending' });
            schedule_unreal_reconnect();
        }
    });

    connectingSocket.on("close", function() {
        requestDebugDatabaseScheduler.cancel(connectingSocket);
        // connection.console.log('Ceconnecting to unreal due to close');
        if (unreal === connectingSocket)
        {
            connectingSocket.destroy();
            unreal = null;
            connectAttemptFence.complete(attempt);
            UnrealConnected = false;
            if (ReceivingTypesTimeout)
            {
                clearTimeout(ReceivingTypesTimeout);
                ReceivingTypesTimeout = null;
            }
            automationRuntime.abortLiveRefresh('Unreal TCP connection closed.');
            resumeRestoredNativeDiagnosticsIfNeeded();
            readinessController.update({ unrealConnected: false, editorProcessId: undefined, editorIdentityVerification: 'pending' });
            schedule_unreal_reconnect();
        }
    });

    connectingSocket.connect(port, hostname, async function()
    {
        connectingSocket.pause();
        if (!isCurrentAttempt())
        {
            connectingSocket.destroy();
            return;
        }
        let tuple = {
            localAddress: connectingSocket.localAddress,
            localPort: connectingSocket.localPort,
            remoteAddress: connectingSocket.remoteAddress ?? '',
            remotePort: connectingSocket.remotePort ?? 0,
        };
        let postflight = await verifyEstablishedEditorConnectionIdentity({
            port,
            uprojectPath: attemptOptions.uprojectPath,
        }, tuple, preflight.processId);
        if (!isCurrentAttempt())
        {
            connectingSocket.destroy();
            return;
        }
        if (!postflight.ok || unreal !== connectingSocket)
        {
            requestDebugDatabaseScheduler.cancel(connectingSocket);
            connectAttemptFence.complete(attempt);
            connectingSocket.destroy();
            unreal = null;
            readinessController.update({
                unrealConnected: false,
                editorProcessId: undefined,
                editorIdentityVerification: postflight.ok === false && postflight.code == 'unsupported-platform'
                    ? 'unsupported-platform'
                    : 'rejected',
            });
            schedule_unreal_reconnect();
            return;
        }
        connectingSocket.resume();
        if (!isCurrentAttempt())
        {
            connectingSocket.destroy();
            return;
        }
        connectAttemptFence.complete(attempt);
        // connection.console.log('Connection to unreal editor established.');
        UnrealConnected = true;
        readinessController.update({
            unrealConnected: true,
            editorProcessId: postflight.processId,
            editorIdentityVerification: 'verified',
        });
        if (LanguageServerStopping || LanguageServerOptions !== attemptOptions || unreal !== connectingSocket)
        {
            connectingSocket.destroy();
            return;
        }
        requestDebugDatabaseScheduler.schedule(
            connectingSocket,
            LANGUAGE_SERVER_TIMEOUTS_MS.verifiedDebugDatabaseRequestDelay,
            () => unreal === connectingSocket && UnrealConnected && !LanguageServerStopping,
            () => {
            let reqDb = buildLegacyRequestDebugDatabase();
            connectingSocket.write(Uint8Array.from(reqDb));
            },
        );
    });
}

function ResolveScriptRoot(workspaceRoot : string) : string
{
    return workspaceLayout.ResolveScriptRoot(workspaceRoot);
}

function ResolveScriptRoots(workspaceRoots : Array<string>) : Array<string>
{
    return workspaceLayout.ResolveScriptRoots(workspaceRoots);
}

function ResolveCacheRoot(scriptRoots : Array<string>) : string
{
    return workspaceLayout.ResolveCacheRoot(scriptRoots);
}

function ResolveScriptRootUris(scriptRoots : Array<string>) : Array<string>
{
    return workspaceLayout.ResolveScriptRootUris(scriptRoots, getFileUri);
}

function ResolveInitialScriptIgnorePatterns(initializationOptions : any) : Array<string>
{
    return workspaceLayout.ResolveInitialScriptIgnorePatterns(initializationOptions);
}

// Create a simple text document manager. The text document manager
// supports full document sync only
// Make the text document manager listen on the connection
// for open, change and close text document events

let shouldSendDiagnosticRelatedInformation: boolean = false;
let RootUris : string[] = [];
let ScriptRootPaths : string[] = [];

function IsScriptUri(uri : string) : boolean
{
    return workspaceLayout.IsScriptUri(uri, ScriptRootPaths, getPathName);
}

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params): InitializeResult => {
    shouldSendDiagnosticRelatedInformation = _params.capabilities && _params.capabilities.textDocument && _params.capabilities.textDocument.publishDiagnostics && _params.capabilities.textDocument.publishDiagnostics.relatedInformation;

    let workspaceRoots = [];

    if (_params.workspaceFolders == null) {
        if (_params.rootPath)
            workspaceRoots.push(_params.rootPath);
        else if (_params.rootUri)
            workspaceRoots.push(URI.parse(_params.rootUri).fsPath);
    } else {
        for (let Workspace of _params.workspaceFolders) {
            workspaceRoots.push(URI.parse(Workspace.uri).fsPath);
        }
    }

    let scriptRoots = ResolveScriptRoots(workspaceRoots);
    let inferredProjectRoot = ResolveCacheRoot(scriptRoots) || workspaceRoots[0] || process.cwd();
    LanguageServerOptions = resolveLanguageServerInitializationOptions(_params.initializationOptions, inferredProjectRoot);
    if (LanguageServerOptions.role == 'project-daemon')
        watchProjectDaemonParent(_params.processId);
    port = LanguageServerOptions.debuggerPort;

    const additionalFolders = LanguageServerOptions.additionalScriptRootFolders;
    if (additionalFolders) {
        for (let scriptRootPath of additionalFolders) {
            let additionalScriptRoot = URI.parse(scriptRootPath.uri).fsPath;
            if (!workspaceLayout.IsPathWithinScriptRoots(additionalScriptRoot, scriptRoots))
                scriptRoots.push(additionalScriptRoot);
        }
    }

    ScriptRootPaths = scriptRoots;
    RootUris = ResolveScriptRootUris(scriptRoots);

    connection.console.log("Workspace roots: " + workspaceRoots);
    connection.console.log("Resolved script roots: " + scriptRoots);

    let scriptIgnorePatterns = ResolveInitialScriptIgnorePatterns(_params.initializationOptions);
    scriptSnapshotFileManifestValidator.configure({
        scriptRoots: ScriptRootPaths,
        ignorePatterns: scriptIgnorePatterns,
        isManagedScriptUri: IsScriptUri,
    });
    connection.console.log("Initial script ignore patterns: " + scriptIgnorePatterns);

    CacheRootPath = LanguageServerOptions.canonicalProjectRoot;
    let cacheOutcome = automationRuntime.configure(LanguageServerOptions);
    automationRuntime.beginScriptSemanticRefresh();
    projectDaemonScriptSnapshotProtocol.markSemanticUnsettled();

    //connection.console.log("RootPath: "+RootPath);
    //connection.console.log("RootUri: "+RootUri+" from "+_params.rootUri);

    // Initially read and parse all angelscript files in resolved script roots.
    if (scriptRoots.length == 0)
    {
        void connection.window.showErrorMessage(
            "Unsupported workspace layout for Unreal Angelscript. Open the Script folder directly, or open its parent folder that contains Script."
        );
    }

    let GlobsRemaining = scriptRoots.length;
    for (let RootPath of scriptRoots)
    {
        let globOptions: glob.IOptions = {
            ignore: scriptIgnorePatterns
        };
        glob(RootPath + "/**/*.as", globOptions, function (err: any, files: any)
        {
            if (err)
            {
                connection.console.error("Failed to glob Angelscript files in " + RootPath + ": " + err);
            }
            for (let file of files || [])
            {
                let uri = getFileUri(file);
                let asmodule = scriptfiles.GetOrCreateModule(getModuleName(uri), file, uri);
                LoadQueue.push(asmodule);
            }

            GlobsRemaining -= 1;
            if (GlobsRemaining <= 0)
                TickQueues();
        });

        // Read templates
        glob(RootPath+"/.vscode/templates/*.as.template", null, function(err : any, files : any)
        {
            scriptlenses.LoadFileTemplates(files);
        });
    }

    if (LanguageServerOptions.unrealOnline)
    {
        setImmediate(() => void connect_unreal());
        if (!typedb.HasTypesFromUnreal())
        {
            InitialUnrealConnectionClassificationTimeout = setTimeout(
                DetectUnrealConnectionTimeout,
                LANGUAGE_SERVER_TIMEOUTS_MS.initialOnlineNoTypeDbClassification,
            );
            InitialUnrealConnectionClassificationTimeout.unref();
        }
    }
    else if (!cacheOutcome.loaded)
    {
        readinessController.markPartialReady(cacheOutcome.message, false);
        if (scriptRoots.length == 0)
            TrySettleSemanticGeneration();
    }

    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Incremental,
            },
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: [".", ":"],
            },
            signatureHelpProvider: {
                triggerCharacters: ["(", ")", ","],
                retriggerCharacters: ["="],
            },
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: { "resolveProvider": true },
            definitionProvider: true,
            implementationProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            inlayHintProvider: true,
            inlineValueProvider: true,
            renameProvider: {
                prepareProvider: true
            },
            codeLensProvider: {
                resolveProvider: false
            },
            executeCommandProvider: {
                commands: ["angelscript.openAssets", "angelscript.createBlueprint", "angelscript.editAsset"],
            },
            codeActionProvider: {
                resolveProvider: true,
            },
            semanticTokensProvider: {
                legend: {
                    tokenTypes: scriptsemantics.SemanticTypeList.map(t => "as_"+t),
                    tokenModifiers: [],
                },
                range: false,
                full: {
                    delta: true,
                },
            },
            colorProvider : <DocumentColorRegistrationOptions> {
                documentSelector: null,
            },
            typeHierarchyProvider: true,
            diagnosticProvider: {
                interFileDependencies: true,
                workspaceDiagnostics: true,
            },
        }
    }
});

function DetectUnrealConnectionTimeout()
{
    InitialUnrealConnectionClassificationTimeout = null;
    if (!typedb.HasTypesFromUnreal())
    {
        UnrealTypesTimedOut = true;
        readinessController.markPartialReady('Unreal connection timed out; diagnostics are parse-only.', false);
        TrySettleSemanticGeneration();
    }
}

function cancelInitialUnrealConnectionClassification() : void
{
    if (!InitialUnrealConnectionClassificationTimeout)
        return;
    clearTimeout(InitialUnrealConnectionClassificationTimeout);
    InitialUnrealConnectionClassificationTimeout = null;
}

function DetectUnrealTypeListTimeout()
{
    ReceivingTypesTimeout = null;
    automationRuntime.abortLiveRefresh('DebugDatabase stream timed out before DebugDatabaseFinished.');
    resumeRestoredNativeDiagnosticsIfNeeded();
    if (!typedb.HasTypesFromUnreal())
        UnrealTypesTimedOut = true;
    if (unreal)
        unreal.destroy();
    TrySettleSemanticGeneration();
}

function ArmDebugDatabaseStreamTimeout() : void
{
    if (ReceivingTypesTimeout)
        clearTimeout(ReceivingTypesTimeout);
    ReceivingTypesTimeout = setTimeout(
        DetectUnrealTypeListTimeout,
        LANGUAGE_SERVER_TIMEOUTS_MS.debugDatabaseChunkIntermessage,
    );
}

function CommitLegacyDebugDatabaseBase(socket: Socket, epoch: number) : void
{
    if (unreal !== socket || epoch != UnrealSocketEpoch || !unrealCacheController.isRefreshInProgress())
        return;
    try
    {
        let accepted = automationRuntime.commitLiveRefresh();
        cancelInitialUnrealConnectionClassification();
        PendingReResolveAfterInitialParse = false;
        ScheduleNativeDiagnosticsRefresh(accepted.generation);
    }
    catch (error)
    {
        if (!typedb.HasTypesFromUnreal())
            UnrealTypesTimedOut = true;
        connection.console.error(`DebugDatabase base transaction failed: ${String(error)}`);
        automationRuntime.abortLiveRefresh('DebugDatabase base transaction failed.');
        socket.destroy();
    }
    TrySettleSemanticGeneration();
}

function TickQueues()
{
    IsServicingQueues = true;

    // let startTime = performance.now();

    if (LoadQueueIndex < LoadQueue.length)
    {
        for (let n = 0; n < 200 && LoadQueueIndex < LoadQueue.length; ++n, ++LoadQueueIndex)
        {
            if (!LoadQueue[LoadQueueIndex].loaded)
                scriptfiles.UpdateModuleFromDisk(LoadQueue[LoadQueueIndex]);
            ParseQueue.push(LoadQueue[LoadQueueIndex]);
        }
    }
    else if (LoadQueue.length != 0)
    {
        LoadQueue = [];
        LoadQueueIndex = 0;
    }
    else if (ParseQueueIndex < ParseQueue.length)
    {
        for (let n = 0; n < 10 && ParseQueueIndex < ParseQueue.length; ++n, ++ParseQueueIndex)
        {
            if (!ParseQueue[ParseQueueIndex].parsed)
                scriptfiles.ParseModule(ParseQueue[ParseQueueIndex]);
            PostProcessTypesQueue.push(ParseQueue[ParseQueueIndex]);
        }
    }
    else if (ParseQueue.length != 0)
    {
        ParseQueue = [];
        ParseQueueIndex = 0;
        scriptfiles.SetInitialParseDone();
        PendingReResolveAfterInitialParse = true;
    }
    else if (PostProcessTypesQueueIndex < PostProcessTypesQueue.length)
    {
        if (CanResolveModules())
        {
            for (let n = 0; n < 50 && PostProcessTypesQueueIndex < PostProcessTypesQueue.length; ++n, ++PostProcessTypesQueueIndex)
            {
                if (!PostProcessTypesQueue[PostProcessTypesQueueIndex].typesPostProcessed)
                    scriptfiles.PostProcessModuleTypes(PostProcessTypesQueue[PostProcessTypesQueueIndex]);
                ResolveQueue.push(PostProcessTypesQueue[PostProcessTypesQueueIndex]);
            }
        }
        else if (LanguageServerOptions && (!LanguageServerOptions.unrealOnline || UnrealTypesTimedOut))
        {
            // Offline without a valid cache can still publish parse-only diagnostics.
            for (let module of PostProcessTypesQueue)
            {
                try { scriptdiagnostics.UpdateScriptModuleDiagnostics(module, true); } catch {}
            }
            PostProcessTypesQueue = [];
            PostProcessTypesQueueIndex = 0;
            readinessController.markPartialReady('Native TypeDB is unavailable; diagnostics are parse-only.');
        }
    }
    else if (PostProcessTypesQueue.length != 0)
    {
        PostProcessTypesQueue = [];
        PostProcessTypesQueueIndex = 0;
    }
    else if (ResolveQueueIndex < ResolveQueue.length)
    {
        if (CanResolveModules())
        {
            for (let n = 0; n < 20 && ResolveQueueIndex < ResolveQueue.length; ++n, ++ResolveQueueIndex)
            {
                if (!ResolveQueue[ResolveQueueIndex].resolved)
                {
                    scriptfiles.ResolveModule(ResolveQueue[ResolveQueueIndex]);
                    scriptdiagnostics.UpdateScriptModuleDiagnostics(ResolveQueue[ResolveQueueIndex], true);
                }
            }
        }
    }
    else if (ResolveQueue.length != 0)
    {
        ResolveQueue = [];
        ResolveQueueIndex = 0;
    }

    // let endTime = performance.now();
    // if (endTime - startTime > 40.0)
    // {
    //     let type = "";
    //     if (LoadQueue.length != 0)
    //         type = "Load";
    //     else if (ParseQueue.length != 0)
    //         type = "Parse";
    //     else if (PostProcessTypesQueue.length != 0)
    //         type = "PostProcess";
    //     else if (ResolveQueue.length != 0)
    //         type = "Resolve";

    //     console.log("Servicing queues took "+(endTime - startTime)+" ms for "+type);
    // }

    if (LoadQueue.length != 0 || ParseQueue.length != 0 || PostProcessTypesQueue.length != 0 || ResolveQueue.length != 0)
    {
        setTimeout(TickQueues, 1);
    }
    else
    {
        IsServicingQueues = false;
        MaybeReResolveAfterInitialParse();
        StartPendingNativeDiagnosticsRefresh();
        TrySettleSemanticGeneration();
        // console.log("Finished servicing queues");
    }
}

function DirtyAllDiagnostics()
{
    if (IsServicingQueues)
        return;

    // Update diagnostics on all modules
    let moduleIndex = 0;
    let moduleList = scriptfiles.GetAllLoadedModules();
    let timerHandle = setInterval(UpdateDiagnostics, 1);

    function UpdateDiagnostics()
    {
        for (let i = 0; i < 20; ++i)
        {
            if (moduleIndex >= moduleList.length)
            {
                clearInterval(timerHandle);
                return;
            }

            let module = moduleList[moduleIndex];
            if (module && module.resolved)
                scriptdiagnostics.UpdateScriptModuleDiagnostics(module);
            moduleIndex += 1;
        }
    }
}

function ScheduleNativeDiagnosticsRefresh(generation: number) : void
{
    PendingNativeDiagnosticsGeneration = generation;
    ActiveNativeDiagnosticsCancel?.();
    StartPendingNativeDiagnosticsRefresh();
}

function StartPendingNativeDiagnosticsRefresh() : void
{
    if (PendingNativeDiagnosticsGeneration == null || IsServicingQueues || ActiveNativeDiagnosticsCancel)
        return;

    let resolveGeneration = PendingNativeDiagnosticsGeneration;
    PendingNativeDiagnosticsGeneration = null;
    if (IsServicingQueues)
        return;

    scriptfiles.ClearAllResolvedModules();
    let finishReResolve = reResolveWork.begin();

    // Update diagnostics on all modules
    let moduleIndex = 0;
    let moduleList = scriptfiles.GetAllLoadedModules();
    let timerHandle = setInterval(ReResolveModules, 1);
    let finished = false;
    let cancelThisRefresh = () => finish(true);

    function finish(stale: boolean) : void
    {
        if (finished)
            return;
        finished = true;
        clearInterval(timerHandle);
        if (ActiveNativeDiagnosticsCancel === cancelThisRefresh)
            ActiveNativeDiagnosticsCancel = null;
        if (!stale && resolveGeneration == unrealCacheController.getActiveGeneration())
        {
            automationRuntime.completeNativeRefresh(resolveGeneration);
            ScheduleSemanticTokensRefresh();
        }
        else if (stale)
        {
            automationRuntime.cancelNativeDiagnostics(resolveGeneration);
        }
        finishReResolve();
    }
    ActiveNativeDiagnosticsCancel = cancelThisRefresh;

    function ReResolveModules()
    {
        if (resolveGeneration != unrealCacheController.getActiveGeneration())
        {
            finish(true);
            return;
        }
        for (let i = 0; i < 20; ++i)
        {
            if (moduleIndex >= moduleList.length)
            {
                finish(false);
                return;
            }

            let module = moduleList[moduleIndex];
            if (module && !module.resolved)
            {
                scriptfiles.ResolveModule(module);
                scriptdiagnostics.UpdateScriptModuleDiagnostics(module);
            }
            moduleIndex += 1;
        }
    }
}

function CanResolveModules()
{
    return typedb.HasTypesFromUnreal() && LoadQueue.length == 0;
}

function BeginModuleSemanticRefresh(module : scriptfiles.ASModule) : void
{
    PendingSemanticModules.add(module);
    automationRuntime.beginScriptSemanticRefresh();
    projectDaemonScriptSnapshotProtocol.markSemanticUnsettled();
}

function FinishModuleSemanticRefresh(module : scriptfiles.ASModule) : void
{
    PendingSemanticModules.delete(module);
    TrySettleSemanticGeneration();
}

function TrySettleSemanticGeneration() : void
{
    if (LanguageServerStopping)
        return;
    if (PendingSemanticModules.size != 0 || IsServicingQueues || reResolveWork.hasActiveWork()
        || PendingNativeDiagnosticsGeneration != null
        || automationRuntime.nativeRefreshPending)
        return;
    if (CanResolveModules() && scriptfiles.GetAllLoadedModules().every((module) => module.resolved))
    {
        automationRuntime.markCurrentGenerationFullReady();
        if (readinessController.snapshot().fullReady)
            projectDaemonScriptSnapshotProtocol.markSemanticSettled();
    }
    else if (readinessController.snapshot().stage == 'partial')
    {
        readinessController.markPartialReady(readinessController.snapshot().cacheMessage);
    }
    else if (LanguageServerOptions && (!LanguageServerOptions.unrealOnline || UnrealTypesTimedOut))
    {
        readinessController.markPartialReady('Native TypeDB is unavailable; diagnostics are parse-only.');
    }
}

function ScheduleSemanticTokensRefresh()
{
    if (SemanticTokensRefreshTimeout)
        return;

    SemanticTokensRefreshTimeout = setTimeout(function()
    {
        SemanticTokensRefreshTimeout = null;
        try
        {
            connection.languages.semanticTokens.refresh();
        }
        catch
        {
        }
    }, 50);
}

function MaybeReResolveAfterInitialParse()
{
    if (!PendingReResolveAfterInitialParse)
        return;
    if (!typedb.HasTypesFromUnreal())
        return;
    if (IsServicingQueues)
        return;

    PendingReResolveAfterInitialParse = false;
    let activeGeneration = unrealCacheController.getActiveGeneration();
    if (activeGeneration !== undefined)
        ScheduleNativeDiagnosticsRefresh(activeGeneration);
}

function IsInitialParseDone()
{
    return CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0;
}

scriptdiagnostics.OnDiagnosticsChanged( function (uri : string, diagnostics : Array<Diagnostic>, projectStaticDiagnostics : readonly Diagnostic[]){
    automationRuntime.updateDiagnostics(uri, projectStaticDiagnostics);
    connection.sendDiagnostics({ "uri": uri, "diagnostics": diagnostics });
});

connection.onDidChangeWatchedFiles((_change) => {
    for(let change of _change.changes)
    {
        if (!IsScriptUri(change.uri))
            continue;

        let module = scriptfiles.GetOrCreateModule(getModuleName(change.uri), getPathName(change.uri), change.uri);
        if (module)
        {
            BeginModuleSemanticRefresh(module);
            if (!module.isOpened)
                scriptfiles.UpdateModuleFromDisk(module);
            scriptfiles.ParseModule(module);

            if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
            {
                scriptfiles.PostProcessModuleTypes(module);
                scriptfiles.ResolveModule(module);
                let alwaysSendDiagnostics = false;
                if (change.type == FileChangeType.Deleted)
                    alwaysSendDiagnostics = true;
                if (change.type == FileChangeType.Created)
                    alwaysSendDiagnostics = true;

                scriptdiagnostics.UpdateScriptModuleDiagnostics(module, false, alwaysSendDiagnostics);
            }
            FinishModuleSemanticRefresh(module);
        }
    }
});

function GetAndParseModule(uri : string) : scriptfiles.ASModule
{
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return null;

    scriptfiles.LoadAndParseModule(asmodule);
    if (CanResolveModules())
    {
        scriptfiles.PostProcessModuleTypes(asmodule);
        scriptfiles.ResolveModule(asmodule);
    }
    return asmodule;
}

connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    // let startTime = performance.now();
    let completions = parsedcompletion.Complete(asmodule, _textDocumentPosition.position);
    // let endTime = performance.now();
    // console.log("Generating completion took "+(endTime - startTime)+" ms");
    return completions;
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    let resolvedItem = parsedcompletion.Resolve(item);
    if (resolvedItem)
        return resolvedItem;
    else
        return item;
});

connection.onSignatureHelp((_textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    let help = parsedcompletion.Signature(asmodule, _textDocumentPosition.position);
    return help;
});

connection.onDefinition((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    let definitions = scriptsymbols.GetDefinition(asmodule, _textDocumentPosition.position);
    if (definitions && definitions.length == 1)
        return definitions[0];
    return definitions;
});

connection.onImplementation((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    let definitions = scriptsymbols.GetDefinition(asmodule, _textDocumentPosition.position);
    if (definitions && definitions.length != 0)
    {
        if (definitions.length == 1)
            return definitions[0];
        return definitions;
    }

    let cppSymbol = scriptsymbols.GetCppSymbol(asmodule, _textDocumentPosition.position);
    if (cppSymbol)
    {
        // the unreal editor with the type and symbol we've resolved that we want.
        if (unreal)
            unreal.write(Uint8Array.from(buildGoTo(cppSymbol[0], cppSymbol[1])));
    }

    return null;
});

connection.onHover((_textDocumentPosition: TextDocumentPositionParams): Hover => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    return scriptsymbols.GetHover(asmodule, _textDocumentPosition.position);
});

connection.onDocumentSymbol((_params : DocumentSymbolParams) : DocumentSymbol[] => {
    let asmodule = GetAndParseModule(_params.textDocument.uri);
    if (!asmodule)
        return null;
    return scriptsymbols.DocumentSymbols(asmodule);
});

connection.onWorkspaceSymbol((_params : WorkspaceSymbolParams) : WorkspaceSymbol[] => {
    return scriptsymbols.WorkspaceSymbols(_params.query);
});

connection.onWorkspaceSymbolResolve((symbol : WorkspaceSymbol) : WorkspaceSymbol => {
    return scriptsymbols.ResolveWorkspaceSymbol(symbol);
});

connection.onReferences(function (params : ReferenceParams) : Location[] | Thenable<Location[]>
{
    if (!CanResolveModules())
        return null;
    if (LoadQueue.length != 0)
        return null;

    let generator = scriptreferences.FindReferences(params.textDocument.uri, params.position);
    let result = generator.next();
    if (result && result.value)
        return result.value;

    return new Promise((resolve, reject) => {
        let timerHandle = setInterval(MakeProgress, 1);
        function MakeProgress()
        {
            let result = generator.next();
            if (result && result.value)
            {
                clearInterval(timerHandle);
                resolve(result.value);
            }
        }
    });
});

connection.onPrepareRename(function (params : PrepareRenameParams) : Range | ResponseError<void>
{
    if (!CanResolveModules())
        return null;
    if (LoadQueue.length != 0)
        return null;

    let result : Range | ResponseError<void> = null;
    if (!CanResolveModules())
        result = new ResponseError<void>(0, "Please wait for all script parsing to finish...");
    else
        result = scriptreferences.PrepareRename(params.textDocument.uri, params.position);

    return result;
});

connection.onRenameRequest(function (params : RenameParams) : WorkspaceEdit | Thenable<WorkspaceEdit>
{
    if (!CanResolveModules())
        return null;
    if (LoadQueue.length != 0)
        return null;

    let generator = scriptreferences.PerformRename(params.textDocument.uri, params.position, params.newName);
    return new Promise((resolve, reject) => {
        let timerHandle = setInterval(MakeProgress, 1);
        function MakeProgress()
        {
            let result = generator.next();
            if (result && result.value)
            {
                clearInterval(timerHandle);

                let workspaceEdit : WorkspaceEdit = {};
                workspaceEdit.changes = {};
                for (let [uri, edits] of result.value)
                    workspaceEdit.changes[uri] = edits;
                resolve(workspaceEdit);
            }
        }
    });
});

connection.onDocumentHighlight(function (params : DocumentHighlightParams) : Array<DocumentHighlight>
{
    if (!CanResolveModules())
        return null
    return scriptoccurances.HighlightOccurances(params.textDocument.uri, params.position);
})

connection.onCodeLens(function (params : CodeLensParams) : CodeLens[]
{
    if (!CanResolveModules())
        return null;
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (!asmodule)
        return null;

    scriptfiles.LoadAndParseModule(asmodule);
    scriptfiles.PostProcessModuleTypes(asmodule);
    scriptfiles.ResolveModule(asmodule);
    return scriptlenses.ComputeCodeLenses(asmodule);
})

connection.onCodeLensResolve(function (lens : CodeLens) : CodeLens{
    return lens;
});

connection.onExecuteCommand(function (params : ExecuteCommandParams)
{
    if (params.command == "angelscript.openAssets")
    {
        if (params.arguments && params.arguments[0])
        {
            let argList = params.arguments as Array<any>;
            let className = argList[0];

            let references = assets.GetAssetsImplementing(argList[0]);
            if (!references || references.length == 0)
                return;

            if (unreal)
                unreal.write(buildOpenAssets(references, className) as any);
            else
                connection.window.showErrorMessage("Cannot open asset: not connected to unreal editor.");
        }
    }
    else if (params.command == "angelscript.editAsset")
    {
        if (params.arguments && params.arguments[0])
        {
            let assetPath = params.arguments[0] as string;
            if (unreal)
                unreal.write(buildOpenAssets([assetPath], "") as any);
            else
                connection.window.showErrorMessage("Cannot edit asset: not connected to unreal editor.");
        }
    }
    else if (params.command == "angelscript.createBlueprint")
    {
        if (params.arguments && params.arguments[0])
        {
            let className = params.arguments[0] as string;
            if (unreal)
                unreal.write(buildCreateBlueprint(className) as any);
            else
                connection.window.showErrorMessage("Cannot create blueprint: not connected to unreal editor.");
        }
    }
});

connection.onCodeAction(function (params : CodeActionParams) : Array<CodeAction>
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return scriptactions.GetCodeActions(asmodule, params.range, params.context.diagnostics);
});

connection.onCodeActionResolve(function (action : CodeAction) : CodeAction
{
    let data = action.data as any;
    if (!data || !data.uri)
        return action;
    let asmodule = GetAndParseModule(data.uri);
    if (!asmodule)
        return action;
    if (!asmodule.resolved)
        return action;

    return scriptactions.ResolveCodeAction(asmodule, action, data);
});

function ReplaceScriptAssetDefinition(assetName : string, assetContent : Array<string>)
{
    // Find the literal asset
    let asset = scriptfiles.ScriptLiteralAssetsByName.get(assetName);
    if (!asset)
        return;

    let outerIndent = scriptactions.GetIndentForStatement(asset.statement);
    let indent = scriptactions.GetIndentForBlock(asset.content_scope);

    let newContent = "\n";
    for (let line of assetContent)
    {
        newContent += indent+line;
        newContent += "\n";
    }
    newContent += outerIndent;

    let edit = <WorkspaceEdit> {};
    edit.changes = {};
    edit.changes[asset.module.displayUri] = [
        TextEdit.replace(
            asset.module.getRange(asset.content_scope.start_offset, asset.content_scope.end_offset),
            newContent)
    ];

    connection.workspace.applyEdit(edit);
    connection.sendNotification("angelscript/wantSave", [asset.module.displayUri]);
}

function TryResolveSymbols(asmodule : scriptfiles.ASModule) : SemanticTokens | null
{
    if (CanResolveModules())
    {
        if (!asmodule)
            return null;
        scriptfiles.LoadAndParseModule(asmodule);
        scriptfiles.PostProcessModuleTypes(asmodule);
        scriptfiles.ResolveModule(asmodule);
        return scriptsemantics.HighlightSymbols(asmodule);
    }
    else
    {
        return null;
    }
}

function WaitForResolveSymbols(params : SemanticTokensParams) : SemanticTokens | Thenable<SemanticTokens>
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    let result = TryResolveSymbols(asmodule);
    if (result)
        return result;

    function timerFunc(resolve : any, reject : any, triesLeft : number) {
        let result = TryResolveSymbols(asmodule);
        if (result)
            return resolve(result);
        setTimeout(function() { timerFunc(resolve, reject, triesLeft-1); }, 100);
    }
    let promise = new Promise<SemanticTokens>(function(resolve, reject)
    {
        timerFunc(resolve, reject, 50);
    });
    return promise;
};

connection.languages.semanticTokens.onDelta(function (params : SemanticTokensDeltaParams) : SemanticTokensDelta | Thenable<SemanticTokensDelta> | SemanticTokens | Thenable<SemanticTokens>
{
    if (!CanResolveModules())
        return WaitForResolveSymbols(params);

    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    scriptfiles.LoadAndParseModule(asmodule);
    scriptfiles.PostProcessModuleTypes(asmodule);
    scriptfiles.ResolveModule(asmodule);
    let delta = scriptsemantics.HighlightSymbolsDelta(asmodule, params.previousResultId);
    return delta;
});

connection.languages.semanticTokens.on(function(params : SemanticTokensParams) : SemanticTokens | Thenable<SemanticTokens>
{
    return WaitForResolveSymbols(params);
});

function getPathName(uri : string) : string
{
    let pathname = decodeURIComponent(uri.replace("file://", "")).replace(/\//g, "\\");
    if(pathname.startsWith("\\"))
        pathname = pathname.substr(1);

    return pathname;
}

function getFileUri(pathname : string) : string
{
    let uri = pathname.replace(/\\/g, "/");
    if(!uri.startsWith("/"))
        uri = "/" + uri;

    return ("file://" + uri);
}

function getModuleName(uri : string) : string
{
    let modulename = decodeURIComponent(uri);

    // This assumes all relative paths are globally unique.
    for (let rootUri of RootUris) {
        let isMatch = false;
        if (process.platform == "win32")
            isMatch = modulename.toLowerCase().startsWith(rootUri.toLowerCase());
        else
            isMatch = modulename.startsWith(rootUri);

        if (isMatch) {
            modulename = modulename.substring(rootUri.length);
            break;
        }
    }
    modulename = modulename.replace(".as", "");
    modulename = modulename.replace(/\//g, ".");

    if (modulename[0] == '.')
        modulename = modulename.substr(1);

    return modulename;
}

function ApplyAcceptedScriptSnapshot(
    changes: readonly ScriptSnapshotChange[],
    _identity: ScriptSnapshotIdentity,
    content: ValidatedScriptSnapshotContent | undefined,
) : void
{
    if (!LanguageServerOptions || LanguageServerOptions.role != 'project-daemon')
        throw new Error('Project-daemon script snapshot was accepted before project-daemon initialization.');

    projectDaemonScriptSnapshotProtocol.markSemanticUnsettled();
    automationRuntime.beginScriptSemanticRefresh();
    for (let change of changes)
    {
        let filePath = URI.parse(change.uri).fsPath;
        let module = scriptfiles.GetOrCreateModule(getModuleName(change.uri), filePath, change.uri);
        if (change.kind == 'deleted')
        {
            scriptfiles.UpdateModuleFromContent(module, '');
            module.exists = false;
        }
        else
        {
            let bytes = content?.get(change.uri);
            if (!bytes)
                throw new Error(`Accepted script snapshot content is unavailable for ${change.uri}.`);
            let source = Buffer.from(bytes).toString('utf8');
            if (source.charCodeAt(0) == 0xfeff)
                source = source.substring(1);
            scriptfiles.UpdateModuleFromContent(module, source);
        }
        scriptfiles.ParseModule(module);
        if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
        {
            scriptfiles.PostProcessModuleTypes(module);
            scriptfiles.ResolveModule(module);
            scriptdiagnostics.UpdateScriptModuleDiagnostics(module, false, change.kind != 'changed');
        }
    }
    TrySettleSemanticGeneration();
}

registerApiRequestHandlers({
    connection,
    isUnrealConnected: () => UnrealConnected,
    getFullReadyStatus: () => readinessController.snapshot(),
    getDebugDatabaseAccessReadiness: () => LanguageServerOptions?.role == 'project-daemon'
        ? unrealCacheController.getDebugDatabaseAccessReadiness()
        : 'complete',
});

connection.languages.inlineValue.on(function (params : InlineValueParams) : Array<InlineValue> {
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    return inlinevalues.ProvideInlineValues(asmodule, params.context.stoppedLocation.start);
});

function TriggerThrottledModuleParse(asmodule : scriptfiles.ASModule)
{
    if (!asmodule.parseDelay)
    {
        // We don't parse because of didChange more than ten times per second,
        // so we don't end up with a giant backlog of parses.
        scriptfiles.LoadAndParseModule(asmodule);
        if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
        {
            scriptfiles.PostProcessModuleTypes(asmodule);
            scriptfiles.ResolveModule(asmodule);
            scriptdiagnostics.UpdateScriptModuleDiagnostics(asmodule);
        }
        FinishModuleSemanticRefresh(asmodule);

        asmodule.parseDelay = setTimeout(function() {
            asmodule.parseDelay = null;

            if (asmodule.parseAfterDelay)
            {
                asmodule.parseAfterDelay = false;
                TriggerThrottledModuleParse(asmodule);
            }
        }, 100);
    }
    else
    {
        asmodule.parseAfterDelay = true;
    }
}

connection.onDidChangeTextDocument((params) => {
    // The content of a text document did change in VSCode.
    // params.uri uniquely identifies the document.
    // params.contentChanges describe the content changes to the document.
    if (params.contentChanges.length == 0)
        return;

    let uri = params.textDocument.uri;
    if (!IsScriptUri(uri))
        return;

    let modulename = getModuleName(uri);

    let asmodule = scriptfiles.GetOrCreateModule(modulename, getPathName(uri), uri);
    BeginModuleSemanticRefresh(asmodule);
    if (!asmodule.loaded)
        scriptfiles.UpdateModuleFromDisk(asmodule);
    scriptfiles.UpdateModuleFromContentChanges(asmodule, params.contentChanges);
    TriggerThrottledModuleParse(asmodule);

    if (asmodule.lastEditStart != -1 && parsedcompletion.GetCompletionSettings().correctFloatLiteralsWhenExpectingDoublePrecision)
    {
        let floatPromise = parsedcompletion.HandleFloatLiteralHelper(asmodule);
        if (floatPromise)
        {
            floatPromise.then(
                function (edit : WorkspaceEdit)
                {
                    if (edit)
                        connection.workspace.applyEdit(edit);
                });
        }
    }
});

connection.onDidOpenTextDocument(function (params : DidOpenTextDocumentParams)
{
    let uri = params.textDocument.uri;
    if (!IsScriptUri(uri))
        return;

    let modulename = getModuleName(uri);

    let asmodule = scriptfiles.GetOrCreateModule(modulename, getPathName(uri), uri);
    BeginModuleSemanticRefresh(asmodule);
    asmodule.isOpened = true;
    scriptfiles.UpdateModuleFromContent(asmodule, params.textDocument.text);
    scriptfiles.LoadAndParseModule(asmodule);
    if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
    {
        scriptfiles.PostProcessModuleTypes(asmodule);
        scriptfiles.ResolveModule(asmodule);
        scriptdiagnostics.UpdateScriptModuleDiagnostics(asmodule);
    }
    FinishModuleSemanticRefresh(asmodule);
});

connection.onDidCloseTextDocument(function (params : DidCloseTextDocumentParams)
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (asmodule)
        asmodule.isOpened = false;
});

connection.onDidChangeConfiguration(function (change : DidChangeConfigurationParams)
{
    let settingsObject = change.settings as any;
    settings = settingsObject.UnrealAngelscript;
    if (!settings)
        return;

    let diagnosticSettings = scriptdiagnostics.GetDiagnosticSettings();
    let dirtyDiagnostics = false;

    if (diagnosticSettings.namingConventionDiagnostics != settings.diagnosticsForUnrealNamingConvention)
    {
        diagnosticSettings.namingConventionDiagnostics = settings.diagnosticsForUnrealNamingConvention;
        dirtyDiagnostics = true;
    }

    if (diagnosticSettings.markUnreadVariablesAsUnused != settings.markUnreadVariablesAsUnused)
    {
        diagnosticSettings.markUnreadVariablesAsUnused = settings.markUnreadVariablesAsUnused;
        dirtyDiagnostics = true;
    }

    if (dirtyDiagnostics)
        DirtyAllDiagnostics();

    if (port != settings.unrealConnectionPort)
    {
        port = settings.unrealConnectionPort;

        // If the port has changed, reconnect
        if (LanguageServerOptions?.unrealOnline)
            void connect_unreal();
    }

    let completionSettings = parsedcompletion.GetCompletionSettings();
    completionSettings.mathCompletionShortcuts = settings.mathCompletionShortcuts;
    completionSettings.dependencyRestrictions = settings.completion.dependencyRestrictions;
    completionSettings.correctFloatLiteralsWhenExpectingDoublePrecision = settings.correctFloatLiteralsWhenExpectingDoublePrecision;
    parsedcompletion.RefreshDependencyRestrictions();

    let inlayHintSettings = inlayhints.GetInlayHintSettings();
    inlayHintSettings.inlayHintsEnabled = settings.inlayHints.inlayHintsEnabled;
    inlayHintSettings.parameterHintsForConstants = settings.inlayHints.parameterHintsForConstants;
    inlayHintSettings.parameterHintsForComplexExpressions = settings.inlayHints.parameterHintsForComplexExpressions;
    inlayHintSettings.parameterReferenceHints = settings.inlayHints.parameterReferenceHints;
    inlayHintSettings.parameterHintsForSingleParameterFunctions = settings.inlayHints.parameterHintsForSingleParameterFunctions;
    inlayHintSettings.typeHintsForAutos = settings.inlayHints.typeHintsForAutos;
    inlayHintSettings.typeHintsIgnoredTypes = new Set<string>(settings.inlayHints.typeHintsForAutoIgnoredTypes as Array<string>);
    inlayHintSettings.parameterHintsIgnoredParameterNames = new Set<string>(settings.inlayHints.parameterHintsIgnoredParameterNames as Array<string>);
    inlayHintSettings.parameterHintsIgnoredFunctionNames = new Set<string>(settings.inlayHints.parameterHintsIgnoredFunctionNames as Array<string>);

    let inlineValueSettings = inlinevalues.GetInlineValueSettings();
    inlineValueSettings.showInlineValueForFunctionThisObject = settings.inlineValues.showInlineValueForFunctionThisObject;
    inlineValueSettings.showInlineValueForLocalVariables = settings.inlineValues.showInlineValueForLocalVariables;
    inlineValueSettings.showInlineValueForParameters = settings.inlineValues.showInlineValueForParameters;
    inlineValueSettings.showInlineValueForMemberAssignment = settings.inlineValues.showInlineValueForMemberAssignment;

    let codeLensSettings = scriptlenses.GetCodeLensSettings();
    codeLensSettings.showCreateBlueprintClasses = settings.codeLenses.showCreateBlueprintClasses;

    let projectCodeGenerationSettings = generatedcode.GetProjectCodeGenerationSettings();
    projectCodeGenerationSettings.enable = settings.projectCodeGeneration.enable;
    projectCodeGenerationSettings.generators = settings.projectCodeGeneration.generators;
});

function TryResolveInlayHints(asmodule : scriptfiles.ASModule, range : Range) : Array<InlayHint> | null
{
    if (CanResolveModules())
    {
        if (!asmodule)
            return null;
        scriptfiles.LoadAndParseModule(asmodule);
        scriptfiles.PostProcessModuleTypes(asmodule);
        scriptfiles.ResolveModule(asmodule);
        return inlayhints.GetInlayHintsForRange(asmodule, range);
    }
    else
    {
        return null;
    }
}

function WaitForInlayHints(uri : string, range : Range) : Array<InlayHint> | Thenable<Array<InlayHint>>
{
    let asmodule = scriptfiles.GetModuleByUri(uri);
    let result = TryResolveInlayHints(asmodule, range);
    if (result)
        return result;

    function timerFunc(resolve : any, reject : any, triesLeft : number) {
        let result = TryResolveInlayHints(asmodule, range);
        if (result)
            return resolve(result);
        setTimeout(function() { timerFunc(resolve, reject, triesLeft-1); }, 100);
    }
    let promise = new Promise<Array<InlayHint>>(function(resolve, reject)
    {
        timerFunc(resolve, reject, 50);
    });
    return promise;
};

connection.languages.inlayHint.on(function (params : InlayHintParams) : Array<InlayHint> | Thenable<Array<InlayHint>>
{
    let uri : string = params.textDocument.uri;
    return WaitForInlayHints(uri, params.range);
});

connection.onDocumentColor(function (params : DocumentColorParams) : ColorInformation[]
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return colorpicker.ProvideDocumentColors(asmodule);
});

connection.onColorPresentation(function(params : ColorPresentationParams) : ColorPresentation[]
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return colorpicker.ProvideColorPresentations(asmodule, params.range, params.color);
});

connection.languages.typeHierarchy.onPrepare(function (params : TypeHierarchyPrepareParams) : TypeHierarchyItem[]
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return typehierarchy.PrepareTypeHierarchy(asmodule, params.position);
});

connection.languages.typeHierarchy.onSupertypes(function (params : TypeHierarchySupertypesParams) : TypeHierarchyItem[]
{
    return typehierarchy.GetTypeHierarchySupertypes(params.item);
});

connection.languages.typeHierarchy.onSubtypes(function (params : TypeHierarchySubtypesParams) : TypeHierarchyItem[]
{
    return typehierarchy.GetTypeHierarchySubtypes(params.item);
});

function stopLanguageServerResources() : Promise<boolean>
{
    if (LanguageServerShutdownPromise)
        return LanguageServerShutdownPromise;
    LanguageServerStopping = true;
    projectDaemonScriptSnapshotProtocol.shutdown();
    connectAttemptFence.cancel();
    PendingNativeDiagnosticsGeneration = null;
    ActiveNativeDiagnosticsCancel?.();
    ActiveNativeDiagnosticsCancel = null;
    automationRuntime.abortLiveRefresh('Language Server is stopping.');
    unrealReconnectScheduler.cancel();
    cancelInitialUnrealConnectionClassification();
    if (ParentProcessWatch)
    {
        clearInterval(ParentProcessWatch);
        ParentProcessWatch = null;
    }
    if (ReceivingTypesTimeout)
    {
        clearTimeout(ReceivingTypesTimeout);
        ReceivingTypesTimeout = null;
    }
    if (SemanticTokensRefreshTimeout)
    {
        clearTimeout(SemanticTokensRefreshTimeout);
        SemanticTokensRefreshTimeout = null;
    }
    if (unreal)
    {
        let socket = unreal;
        unreal = null;
        requestDebugDatabaseScheduler.cancel(socket);
        socket.removeAllListeners();
        try { socket.write(Uint8Array.from(buildDisconnect())); } catch {}
        socket.destroy();
    }
    requestDebugDatabaseScheduler.cancelAll();
    UnrealConnected = false;
    readinessController.update({ unrealConnected: false, editorProcessId: undefined, editorIdentityVerification: 'pending' });
    LanguageServerShutdownPromise = automationRuntime.shutdown(
        LANGUAGE_SERVER_TIMEOUTS_MS.shutdownPersistenceFlush,
    );
    return LanguageServerShutdownPromise;
}

connection.onShutdown(async () => {
    await stopLanguageServerResources();
});

connection.onExit(() => {
    void stopLanguageServerResources();
});

if (!ipcSendAvailble)
{
    process.stdin.prependOnceListener('end', () => {
        void stopLanguageServerResources().finally(() => process.exit(0));
    });
}
else
{
    process.once('disconnect', () => {
        void stopLanguageServerResources().finally(() => process.exit(0));
    });
}

// Listen on the connection
connection.listen();
