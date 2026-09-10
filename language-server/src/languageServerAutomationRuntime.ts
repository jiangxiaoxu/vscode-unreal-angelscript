import * as path from 'node:path';
import { Connection, Diagnostic } from 'vscode-languageserver/node';
import { ResolvedAngelScriptLanguageServerOptions } from './languageServerContract';
import { createLanguageServerReadinessController, LanguageServerDiagnosticsStatus } from './languageServerReadiness';
import { createUnrealCacheController, UnrealCacheLoadOutcome, UnrealCacheControllerOptions } from './unrealCacheController';
import {
    buildWorkspaceDiagnosticReport,
    createWorkspaceDiagnosticsRegistry,
    registerWorkspaceDiagnostics,
} from './workspaceDiagnostics';
import { removeLegacyCacheAfterVerifiedPublish } from './legacyCacheCleanup';
import { LANGUAGE_SERVER_TIMEOUTS_MS } from './languageServerTimeouts';

export type LanguageServerAutomationRuntimeOptions = Pick<UnrealCacheControllerOptions,
    'publishCache' | 'publisherRetryDelaysMs'>;

export function createLanguageServerAutomationRuntime(
    connection: Connection,
    extensionVersion: string,
    runtimeOptions: LanguageServerAutomationRuntimeOptions = {},
)
{
    let options: ResolvedAngelScriptLanguageServerOptions | null = null;
    let preRefreshStatus: LanguageServerDiagnosticsStatus | null = null;
    let nativeCandidateGeneration: number | null = null;
    let nativeDiagnosticsGeneration: number | null = null;
    let nativeRefreshSemanticGeneration: number | null = null;
    let lastLoggedPersistenceFailure: string | null = null;
    const diagnostics = createWorkspaceDiagnosticsRegistry();
    const readiness = createLanguageServerReadinessController((status) => {
        connection.sendNotification('angelscript/diagnosticsStatus', status);
    });
    const cache = createUnrealCacheController({
        ...runtimeOptions,
        onPersistenceStatus: (status) => {
            readiness.update({
                cacheState: status.state,
                cacheDirty: status.cacheDirty,
                persistenceAttempt: status.persistenceAttempt,
                cacheMessage: status.state == 'disabled' || status.state == 'missing'
                    ? readiness.snapshot().cacheMessage
                    : undefined,
                activeRevision: status.activeRevision,
                persistedRevision: status.persistedRevision,
                lastPersistenceError: status.lastPersistenceError,
            });
            if (status.state == 'error' && status.lastPersistenceError)
            {
                let failureKey = `${status.pendingRevision}:${status.lastPersistenceError}`;
                if (failureKey != lastLoggedPersistenceFailure)
                {
                    lastLoggedPersistenceFailure = failureKey;
                    connection.console.error(`DebugDatabase cache publication stopped after bounded retries: ${status.lastPersistenceError}`);
                }
            }
            else if (status.state == 'clean')
            {
                lastLoggedPersistenceFailure = null;
            }
        },
        onPublished: () => {
            if (options?.role != 'vscode')
                return;
            let legacyPath = path.join(options.canonicalProjectRoot, 'Script', '.vscode', 'angelscript', 'unreal-cache.json');
            let cleanup = removeLegacyCacheAfterVerifiedPublish(legacyPath);
            if (cleanup.ok === false)
                connection.console.warn(cleanup.reason);
        },
    });
    registerWorkspaceDiagnostics(connection, diagnostics, () => readiness.snapshot());
    connection.onRequest('angelscript/diagnosticsStatus', () => readiness.snapshot());

    function configure(resolvedOptions: ResolvedAngelScriptLanguageServerOptions) : UnrealCacheLoadOutcome
    {
        options = resolvedOptions;
        readiness.update({
            stage: 'loading-cache',
            unrealOnline: options.unrealOnline,
            unrealConnected: false,
        });
        cache.configure({
            cachePath: options.cachePath,
            access: options.cacheAccess,
            projectIdentity: options.projectIdentity,
            budgets: options.budgets,
            producerCompatibility: {
                extensionVersionPrefix: extensionVersion.split('.').slice(0, 2).join('.') + '.',
                ...(process.env.UNREAL_ANGELSCRIPT_LS_COMMIT
                    ? { languageServerCommit: process.env.UNREAL_ANGELSCRIPT_LS_COMMIT }
                    : {}),
            },
        }, {
            extensionVersion,
            languageServerCommit: process.env.UNREAL_ANGELSCRIPT_LS_COMMIT || 'development',
        });
        let outcome = cache.loadCacheFromDisk();
        let persistence = cache.getPersistenceStatus();
        readiness.update({
            cacheState: outcome.loaded
                ? 'clean'
                : (outcome.code == 'disabled' ? 'disabled' : (outcome.code == 'missing' ? 'missing' : 'rejected')),
            cacheDirty: persistence.cacheDirty,
            persistenceAttempt: persistence.persistenceAttempt,
            cacheMessage: outcome.message,
            activeRevision: outcome.revision,
            persistedRevision: outcome.loaded ? outcome.revision : persistence.persistedRevision,
            stage: 'parsing',
        });
        return outcome;
    }

    function beginLiveRefresh() : number
    {
        if (nativeCandidateGeneration != null)
        {
            cache.abortRefresh();
            nativeCandidateGeneration = null;
            preRefreshStatus = null;
        }
        preRefreshStatus = readiness.snapshot();
        let generation = cache.beginRefresh();
        if (cache.hasAcceptedGeneration())
            readiness.update({ generation, unrealConnected: true, unrealOnline: true });
        else
            readiness.beginRefresh(generation);
        nativeCandidateGeneration = generation;
        nativeRefreshSemanticGeneration = readiness.snapshot().semanticGeneration;
        readiness.update({ unrealConnected: true, unrealOnline: true });
        return generation;
    }

    function commitLiveRefresh() : { generation: number; revision: string }
    {
        if (nativeCandidateGeneration == null || nativeCandidateGeneration != cache.getGeneration())
            throw new Error('No native DebugDatabase refresh is pending.');
        let accepted: { generation: number; revision: string };
        try
        {
            accepted = cache.acceptCompleteCandidate();
        }
        catch (error)
        {
            markHydrationFailed(error);
            throw error;
        }

        let status = readiness.snapshot();
        let semanticGeneration = status.semanticGeneration + 1;
        readiness.update({
            generation: accepted.generation,
            semanticGeneration,
            stage: 'resolving',
            fullReady: false,
            coverage: 'none',
            activeRevision: accepted.revision,
            unrealConnected: true,
        });
        nativeCandidateGeneration = null;
        nativeRefreshSemanticGeneration = null;
        nativeDiagnosticsGeneration = accepted.generation;
        preRefreshStatus = null;
        return accepted;
    }

    function markHydrationFailed(error: unknown, unrealConnected = true, rejectCache = true) : void
    {
        if (preRefreshStatus && cache.getActiveRevision())
        {
            let currentStatus = readiness.snapshot();
            let semanticGeneration = currentStatus.semanticGeneration;
            let onlyNativeRefreshChangedSemantics = semanticGeneration == nativeRefreshSemanticGeneration;
            let priorSemanticsWereSettled = preRefreshStatus.semanticGeneration
                == preRefreshStatus.settledSemanticGeneration;
            nativeCandidateGeneration = null;
            nativeRefreshSemanticGeneration = null;
            if (onlyNativeRefreshChangedSemantics)
            {
                readiness.update({
                    generation: cache.getGeneration(),
                    semanticGeneration,
                    settledSemanticGeneration: priorSemanticsWereSettled
                        ? semanticGeneration
                        : preRefreshStatus.settledSemanticGeneration,
                    stage: preRefreshStatus.stage,
                    fullReady: preRefreshStatus.fullReady,
                    coverage: preRefreshStatus.coverage,
                    activeRevision: cache.getActiveRevision(),
                    unrealConnected,
                    ...(unrealConnected ? {} : { editorProcessId: undefined, editorIdentityVerification: 'pending' as const }),
                });
            }
            else
            {
                readiness.update({
                    generation: cache.getGeneration(),
                    activeRevision: cache.getActiveRevision(),
                    unrealConnected,
                    ...(unrealConnected ? {} : { editorProcessId: undefined, editorIdentityVerification: 'pending' as const }),
                });
            }
            preRefreshStatus = null;
            return;
        }
        nativeCandidateGeneration = null;
        nativeRefreshSemanticGeneration = null;
        readiness.update({
            stage: 'partial',
            fullReady: false,
            coverage: 'partial',
            cacheState: rejectCache ? 'rejected' : readiness.snapshot().cacheState,
            cacheMessage: rejectCache
                ? `DebugDatabase hydration failed: ${String(error)}`
                : String(error),
            activeRevision: undefined,
            unrealConnected,
            ...(unrealConnected ? {} : { editorProcessId: undefined, editorIdentityVerification: 'pending' as const }),
        });
        preRefreshStatus = null;
    }

    function abortLiveRefresh(reason: string) : boolean
    {
        if (nativeCandidateGeneration == null || !cache.abortRefresh())
        {
            readiness.update({
                unrealConnected: false,
                editorProcessId: undefined,
                editorIdentityVerification: 'pending',
            });
            return false;
        }
        markHydrationFailed(`DebugDatabase refresh aborted: ${reason}`, false, false);
        return true;
    }

    function markResolving() : void
    {
        preRefreshStatus = null;
        readiness.update({ stage: 'resolving', activeRevision: cache.getActiveRevision() });
    }

    function markCurrentGenerationFullReady() : void
    {
        if (nativeCandidateGeneration != null || nativeDiagnosticsGeneration != null)
            return;
        let generation = cache.getGeneration();
        let revision = cache.getActiveRevision();
        let status = readiness.snapshot();
        if (status.generation != generation || !revision)
            return;
        readiness.update({ generation, activeRevision: revision });
        readiness.markFullReady();
    }

    function updateDiagnostics(uri: string, values: readonly Diagnostic[]) : void
    {
        diagnostics.update(uri, values);
    }

    function beginScriptSemanticRefresh() : number
    {
        return readiness.beginSemanticRefresh();
    }

    function completeNativeRefresh(generation: number) : void
    {
        if (nativeDiagnosticsGeneration == generation)
            nativeDiagnosticsGeneration = null;
    }

    function cancelNativeDiagnostics(generation: number) : void
    {
        if (nativeDiagnosticsGeneration == generation)
            nativeDiagnosticsGeneration = null;
    }

    function resumeNativeDiagnostics(generation: number) : void
    {
        nativeDiagnosticsGeneration = generation;
    }

    async function shutdown(timeoutMs: number = LANGUAGE_SERVER_TIMEOUTS_MS.shutdownPersistenceFlush) : Promise<boolean>
    {
        readiness.update({ stage: 'stopping', fullReady: false });
        return cache.shutdownPersistence(timeoutMs);
    }

    return {
        cache,
        readiness,
        configure,
        beginLiveRefresh,
        commitLiveRefresh,
        markHydrationFailed,
        abortLiveRefresh,
        markResolving,
        markCurrentGenerationFullReady,
        updateDiagnostics,
        getWorkspaceDiagnosticsReport: () => buildWorkspaceDiagnosticReport(diagnostics, readiness.snapshot()),
        beginScriptSemanticRefresh,
        completeNativeRefresh,
        cancelNativeDiagnostics,
        resumeNativeDiagnostics,
        // Access enrichment is orthogonal to the base semantic generation:
        // VS Code can become fully ready after BaseFinished while the
        // project-daemon access gate continues to wait for the sidecar.
        get nativeRefreshPending() { return nativeCandidateGeneration != null || nativeDiagnosticsGeneration != null; },
        shutdown,
        get options() { return options; },
    };
}
