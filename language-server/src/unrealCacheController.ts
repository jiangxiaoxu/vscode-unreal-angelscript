import * as scriptfiles from './as_parser';
import * as typedb from './database';
import * as scriptlenses from './code_lenses';
import * as api_search from './api_search';
import {
    DebugDatabaseCacheContext,
    DebugDatabaseCachePayload,
    DebugDatabaseCacheProducer,
    DebugDatabaseCacheV2,
    createDebugDatabaseRevision,
    loadDebugDatabaseCacheV2,
    saveDebugDatabaseCacheV2Async,
} from './debugDatabaseCacheV2';
import {
    DebugDatabasePersistenceStatus,
    createDebugDatabaseCachePublisher,
} from './debugDatabaseCachePublisher';
import {
    hydrateTypeDatabaseGeneration,
    resetTypeDatabaseForGeneration,
    resolveAllScriptModulesForGeneration,
} from './typeDatabaseGeneration';
import {
    DebugDatabaseAccessChunk,
    normalizeDebugDatabaseAccessChunk,
} from './accessContract';

type CachedScriptSettings = {
    floatIsFloat64 : boolean;
    useAngelscriptHaze : boolean;
    deprecateStaticClass : boolean;
    disallowStaticClass : boolean;
    exposeGlobalFunctions : boolean;
    deprecateActorGenerics : boolean;
    disallowActorGenerics : boolean;
};

type AcceptedDebugDatabaseGeneration = {
    generation: number;
    chunks: unknown[];
    accessChunks: DebugDatabaseAccessChunk[];
    scriptSettings: CachedScriptSettings;
    engineSupportsCreateBlueprint: boolean;
    revision: string;
    accessState: 'base-only' | 'base+access';
};

export type DebugDatabaseAccessReadiness = 'base-only' | 'pending' | 'complete' | 'failed';

export type UnrealCacheLoadOutcome = {
    loaded: boolean;
    code: string;
    message: string;
    revision?: string;
};

export type UnrealCacheControllerOptions = {
    publishCache?: (
        context: DebugDatabaseCacheContext,
        payload: DebugDatabaseCachePayload,
        shouldCommit: () => boolean,
    ) => Promise<DebugDatabaseCacheV2>;
    publisherRetryDelaysMs?: readonly number[];
    onPersistenceStatus?: (status: DebugDatabasePersistenceStatus) => void;
    onPublished?: (cache: DebugDatabaseCacheV2) => void;
};

export type UnrealCacheController = {
    configure: (context: DebugDatabaseCacheContext, producer: DebugDatabaseCacheProducer) => void;
    beginRefresh: () => number;
    abortRefresh: () => boolean;
    isRefreshInProgress: () => boolean;
    hasAcceptedGeneration: () => boolean;
    recordDebugDatabaseChunk: (chunk: unknown) => void;
    recordDebugDatabaseAccessChunk: (chunk: unknown) => void;
    setDebugDatabaseAccessExpected: (expected: boolean) => void;
    finishDebugDatabaseAccess: () => void;
    discardDebugDatabaseAccessChunks: () => void;
    getDebugDatabaseAccessReadiness: () => DebugDatabaseAccessReadiness;
    recordDebugDatabaseSettings: (settings: Partial<CachedScriptSettings>, engineSupportsCreateBlueprint: boolean, accessExpected?: boolean) => void;
    acceptCompleteCandidate: () => { generation: number; revision: string };
    invalidateSearchCache: () => void;
    loadCacheFromDisk: () => UnrealCacheLoadOutcome;
    getActiveRevision: () => string | undefined;
    getActiveGeneration: () => number | undefined;
    getGeneration: () => number;
    getPersistenceStatus: () => DebugDatabasePersistenceStatus;
    flushPersistence: (timeoutMs?: number) => Promise<boolean>;
    shutdownPersistence: (timeoutMs?: number) => Promise<boolean>;
};

function immutableJsonClone<T>(value: T) : T
{
    return JSON.parse(JSON.stringify(value)) as T;
}

export function createUnrealCacheController(
    options: UnrealCacheControllerOptions = {},
) : UnrealCacheController
{
    let pendingDebugDatabaseChunks : Array<unknown> = [];
    let pendingDebugDatabaseAccessChunks : DebugDatabaseAccessChunk[] = [];
    let pendingDebugDatabaseAccessRecordCount = 0;
    let pendingAccessReadiness : DebugDatabaseAccessReadiness = 'base-only';
    let cacheContext : DebugDatabaseCacheContext | null = null;
    let cacheProducer : DebugDatabaseCacheProducer = {
        extensionVersion: 'development',
        languageServerCommit: 'unknown',
    };
    let acceptedGeneration: AcceptedDebugDatabaseGeneration | null = null;
    let generation = 0;
    let refreshInProgress = false;
    let pendingScriptSettings: CachedScriptSettings | null = null;
    let pendingEngineSupportsCreateBlueprint: boolean | null = null;
    let publisher = createDebugDatabaseCachePublisher({
        retryDelaysMs: options.publisherRetryDelaysMs,
        onStatus: options.onPersistenceStatus,
        onPublished: options.onPublished,
    });

    function configure(context: DebugDatabaseCacheContext, producer: DebugDatabaseCacheProducer) : void
    {
        cacheContext = { ...context, budgets: { ...context.budgets } };
        cacheProducer = { ...producer };
        publisher.setInitialState(context.access == 'disabled' ? 'disabled' : 'missing');
    }

    function getCurrentScriptSettings() : CachedScriptSettings
    {
        let scriptSettings = scriptfiles.GetScriptSettings();
        return {
            floatIsFloat64: scriptSettings.floatIsFloat64,
            useAngelscriptHaze: scriptSettings.useAngelscriptHaze,
            deprecateStaticClass: scriptSettings.deprecateStaticClass,
            disallowStaticClass: scriptSettings.disallowStaticClass,
            exposeGlobalFunctions: scriptSettings.exposeGlobalFunctions,
            deprecateActorGenerics: scriptSettings.deprecateActorGenerics,
            disallowActorGenerics: scriptSettings.disallowActorGenerics,
        };
    }

    function applyCachedScriptSettings(settings: Record<string, boolean>, engineSupportsCreateBlueprint: boolean) : void
    {
        let scriptSettings = scriptfiles.GetScriptSettings();
        for (let key of Object.keys(settings) as Array<keyof CachedScriptSettings>)
        {
            if (typeof settings[key] == 'boolean' && key in scriptSettings)
                (scriptSettings as unknown as Record<string, boolean>)[key] = settings[key];
        }
        scriptlenses.GetCodeLensSettings().engineSupportsCreateBlueprint = engineSupportsCreateBlueprint;
    }

    function beginRefresh() : number
    {
        generation += 1;
        pendingDebugDatabaseChunks = [];
        pendingDebugDatabaseAccessChunks = [];
        pendingDebugDatabaseAccessRecordCount = 0;
        pendingAccessReadiness = 'base-only';
        pendingScriptSettings = acceptedGeneration?.scriptSettings ?? getCurrentScriptSettings();
        pendingEngineSupportsCreateBlueprint = acceptedGeneration?.engineSupportsCreateBlueprint
            ?? scriptlenses.GetCodeLensSettings().engineSupportsCreateBlueprint;
        refreshInProgress = true;
        return generation;
    }

    function recordDebugDatabaseChunk(chunk: unknown) : void
    {
        if (refreshInProgress)
            pendingDebugDatabaseChunks.push(chunk);
    }

    function recordDebugDatabaseAccessChunk(chunk: unknown) : void
    {
        if (!refreshInProgress || pendingAccessReadiness != 'pending')
            return;
        let normalized = normalizeDebugDatabaseAccessChunk(chunk);
        pendingDebugDatabaseAccessChunks.push(normalized);
        pendingDebugDatabaseAccessRecordCount += (normalized.properties?.length ?? 0)
            + (normalized.methods?.length ?? 0);
    }

    function setDebugDatabaseAccessExpected(expected: boolean) : void
    {
        if (!refreshInProgress)
            return;
        pendingAccessReadiness = expected ? 'pending' : 'base-only';
        if (!expected)
        {
            pendingDebugDatabaseAccessChunks = [];
            pendingDebugDatabaseAccessRecordCount = 0;
        }
    }

    function finishDebugDatabaseAccess() : void
    {
        if (refreshInProgress && pendingAccessReadiness == 'pending')
            pendingAccessReadiness = pendingDebugDatabaseAccessRecordCount > 0 ? 'complete' : 'failed';
    }

    function discardDebugDatabaseAccessChunks() : void
    {
        if (refreshInProgress)
        {
            pendingDebugDatabaseAccessChunks = [];
            pendingDebugDatabaseAccessRecordCount = 0;
            pendingAccessReadiness = pendingAccessReadiness == 'pending' || pendingAccessReadiness == 'complete'
                ? 'failed'
                : 'base-only';
        }
    }

    function recordDebugDatabaseSettings(
        settings: Partial<CachedScriptSettings>,
        engineSupportsCreateBlueprint: boolean,
        accessExpected = false,
    ) : void
    {
        if (!refreshInProgress || !pendingScriptSettings)
            return;
        pendingScriptSettings = { ...pendingScriptSettings, ...settings };
        pendingEngineSupportsCreateBlueprint = engineSupportsCreateBlueprint;
        setDebugDatabaseAccessExpected(accessExpected);
    }

    function clearCandidate() : void
    {
        pendingDebugDatabaseChunks = [];
        pendingDebugDatabaseAccessChunks = [];
        pendingDebugDatabaseAccessRecordCount = 0;
        pendingAccessReadiness = 'base-only';
        pendingScriptSettings = null;
        pendingEngineSupportsCreateBlueprint = null;
        refreshInProgress = false;
    }

    function abortRefresh() : boolean
    {
        if (!refreshInProgress)
            return false;
        clearCandidate();
        return true;
    }

    function restoreAcceptedGeneration(prior: AcceptedDebugDatabaseGeneration | null) : void
    {
        if (prior)
        {
            applyCachedScriptSettings(prior.scriptSettings, prior.engineSupportsCreateBlueprint);
            hydrateTypeDatabaseGeneration(prior.chunks, prior.scriptSettings.floatIsFloat64, prior.accessChunks);
            resolveAllScriptModulesForGeneration();
        }
        else
        {
            resetTypeDatabaseForGeneration();
            resolveAllScriptModulesForGeneration();
        }
        api_search.InvalidateAPISearchCache();
    }

    function publishAcceptedGeneration(
        acceptedId: number,
        revision: string,
        accessState: 'base-only' | 'base+access',
        chunks: unknown[],
        accessChunks: DebugDatabaseAccessChunk[],
        settings: CachedScriptSettings,
        blueprintSupport: boolean,
    ) : void
    {
        let contextSnapshot = cacheContext ? { ...cacheContext, budgets: { ...cacheContext.budgets } } : null;
        let payload: DebugDatabaseCachePayload | null = contextSnapshot ? immutableJsonClone({
            projectIdentity: contextSnapshot.projectIdentity,
            producer: cacheProducer,
            scriptSettings: settings,
            engineSupportsCreateBlueprint: blueprintSupport,
            accessState,
            debugDatabaseChunks: chunks,
            ...(accessState == 'base+access' ? { debugDatabaseAccessChunks: accessChunks } : {}),
        }) : null;
        publisher.submit({
            generation: acceptedId,
            revision,
            publish: async (isCurrent) => {
                if (!contextSnapshot || !payload)
                    throw new Error('DebugDatabase cache is not configured.');
                let write = options.publishCache ?? saveDebugDatabaseCacheV2Async;
                return write(contextSnapshot, payload, isCurrent);
            },
        });
    }

    function acceptCompleteCandidate() : { generation: number; revision: string }
    {
        if (!refreshInProgress)
            throw new Error('DebugDatabase candidate is incomplete or contains no chunks.');
        if (pendingDebugDatabaseChunks.length == 0)
        {
            clearCandidate();
            throw new Error('DebugDatabase candidate is incomplete or contains no chunks.');
        }

        let nextChunks = immutableJsonClone(pendingDebugDatabaseChunks);
        let nextAccessState: 'base-only' | 'base+access' = pendingAccessReadiness == 'complete'
            ? 'base+access'
            : 'base-only';
        let nextAccessChunks = nextAccessState == 'base+access'
            ? immutableJsonClone(pendingDebugDatabaseAccessChunks)
            : [];
        let nextSettings = { ...(pendingScriptSettings ?? getCurrentScriptSettings()) };
        let nextBlueprintSupport = pendingEngineSupportsCreateBlueprint
            ?? scriptlenses.GetCodeLensSettings().engineSupportsCreateBlueprint;
        let nextRevision = createDebugDatabaseRevision(nextChunks, nextAccessChunks);
        let acceptedId = generation;
        let prior = acceptedGeneration;

        try
        {
            // Candidate validation and hydration are synchronous. No request can observe the
            // temporary global TypeDB before the accepted authority is swapped below.
            applyCachedScriptSettings(nextSettings, nextBlueprintSupport);
            hydrateTypeDatabaseGeneration(nextChunks, nextSettings.floatIsFloat64, nextAccessChunks);
            resolveAllScriptModulesForGeneration();
        }
        catch (error)
        {
            clearCandidate();
            try
            {
                restoreAcceptedGeneration(prior);
            }
            catch (rollbackError)
            {
                acceptedGeneration = null;
                throw new Error(`DebugDatabase candidate failed (${String(error)}); accepted generation restore failed (${String(rollbackError)}).`);
            }
            throw error;
        }

        acceptedGeneration = {
            generation: acceptedId,
            chunks: nextChunks,
            accessChunks: nextAccessChunks,
            scriptSettings: nextSettings,
            engineSupportsCreateBlueprint: nextBlueprintSupport,
            revision: nextRevision,
            accessState: nextAccessState,
        };
        clearCandidate();
        api_search.InvalidateAPISearchCache();

        publishAcceptedGeneration(
            acceptedId,
            nextRevision,
            nextAccessState,
            nextChunks,
            nextAccessChunks,
            nextSettings,
            nextBlueprintSupport,
        );
        return { generation: acceptedId, revision: nextRevision };
    }

    function invalidateSearchCache() : void
    {
        api_search.InvalidateAPISearchCache();
    }

    function loadCacheFromDisk() : UnrealCacheLoadOutcome
    {
        if (!cacheContext)
            return { loaded: false, code: 'not-configured', message: 'Cache is not configured.' };
        if (cacheContext.access == 'disabled')
            return { loaded: false, code: 'disabled', message: 'Cache is disabled because exact project identity is unavailable.' };
        if (typedb.HasTypesFromUnreal())
        {
            let activeRevision = acceptedGeneration?.revision;
            return { loaded: true, code: 'already-ready', message: 'Type database is already populated.', revision: activeRevision };
        }

        let result = loadDebugDatabaseCacheV2(cacheContext);
        if (result.ok === false)
        {
            publisher.setInitialState('missing');
            return { loaded: false, code: result.code, message: result.message };
        }

        let previousSettings = getCurrentScriptSettings();
        let previousBlueprintSupport = scriptlenses.GetCodeLensSettings().engineSupportsCreateBlueprint;
        try
        {
            applyCachedScriptSettings(result.cache.scriptSettings, result.cache.engineSupportsCreateBlueprint);
            let accessChunks = (result.cache.accessState == 'base+access' ? result.cache.debugDatabaseAccessChunks ?? [] : [])
                .map((chunk) => normalizeDebugDatabaseAccessChunk(chunk));
            hydrateTypeDatabaseGeneration(result.cache.debugDatabaseChunks, scriptfiles.GetScriptSettings().floatIsFloat64, accessChunks);
        }
        catch (error)
        {
            applyCachedScriptSettings(previousSettings, previousBlueprintSupport);
            publisher.setInitialState('missing');
            return { loaded: false, code: 'hydrate-failed', message: `Cache TypeDB hydration failed: ${String(error)}` };
        }
        api_search.InvalidateAPISearchCache();
        acceptedGeneration = {
            generation,
            chunks: immutableJsonClone(result.cache.debugDatabaseChunks),
            accessChunks: (result.cache.debugDatabaseAccessChunks ?? [])
                .map((chunk) => normalizeDebugDatabaseAccessChunk(chunk)),
            scriptSettings: getCurrentScriptSettings(),
            engineSupportsCreateBlueprint: scriptlenses.GetCodeLensSettings().engineSupportsCreateBlueprint,
            revision: result.cache.revision,
            accessState: result.cache.accessState,
        };
        publisher.setInitialState('clean', result.cache.revision);
        return { loaded: true, code: 'loaded', message: 'Loaded debug database cache v2.', revision: result.cache.revision };
    }

    return {
        configure,
        beginRefresh,
        abortRefresh,
        isRefreshInProgress: () => refreshInProgress,
        hasAcceptedGeneration: () => acceptedGeneration != null,
        recordDebugDatabaseChunk,
        recordDebugDatabaseAccessChunk,
        setDebugDatabaseAccessExpected,
        finishDebugDatabaseAccess,
        discardDebugDatabaseAccessChunks,
        getDebugDatabaseAccessReadiness: () => refreshInProgress
            ? pendingAccessReadiness
            : acceptedGeneration?.accessState == 'base+access' ? 'complete' : 'base-only',
        recordDebugDatabaseSettings,
        acceptCompleteCandidate,
        invalidateSearchCache,
        loadCacheFromDisk,
        getActiveRevision: () => acceptedGeneration?.revision,
        getActiveGeneration: () => acceptedGeneration?.generation,
        getGeneration: () => generation,
        getPersistenceStatus: publisher.snapshot,
        flushPersistence: publisher.flush,
        shutdownPersistence: publisher.shutdown,
    };
}
