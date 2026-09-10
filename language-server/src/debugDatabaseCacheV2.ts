import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { AngelScriptLanguageServerBudgets, AngelScriptCacheAccess } from './languageServerContract';
import { normalizeDebugDatabaseAccessChunk } from './accessContract';

export const DEBUG_DATABASE_CACHE_SCHEMA = 'unreal-angelscript-debug-database';
export const DEBUG_DATABASE_CACHE_VERSION = 3;

export type DebugDatabaseCacheProducer = {
    extensionVersion: string;
    languageServerCommit: string;
    engineVersion?: string;
    pluginVersion?: string;
};

export type DebugDatabaseCacheV2 = {
    schema: typeof DEBUG_DATABASE_CACHE_SCHEMA;
    version: typeof DEBUG_DATABASE_CACHE_VERSION;
    projectIdentity: string;
    revision: string;
    contentHash: string;
    createdAt: string;
    producer: DebugDatabaseCacheProducer;
    scriptSettings: Record<string, boolean>;
    engineSupportsCreateBlueprint: boolean;
    complete: true;
    /** Explicitly distinguishes a valid legacy/base-only snapshot from a
     * complete base-plus-access snapshot.  Missing values are invalid. */
    accessState?: 'base-only' | 'base+access';
    debugDatabaseChunks: unknown[];
    debugDatabaseAccessChunks?: unknown[];
};

export type DebugDatabaseCachePayload = Omit<DebugDatabaseCacheV2,
    'schema' | 'version' | 'revision' | 'contentHash' | 'createdAt' | 'complete'>;

export type DebugDatabaseCacheLoadResult =
    | { ok: true; cache: DebugDatabaseCacheV2 }
    | { ok: false; code: 'missing' | 'compressed-budget' | 'uncompressed-budget' | 'invalid-gzip' | 'invalid-json' | 'invalid-schema' | 'identity-mismatch' | 'producer-mismatch' | 'hash-mismatch' | 'chunk-budget'; message: string };

export type DebugDatabaseCacheContext = {
    cachePath: string;
    access: AngelScriptCacheAccess;
    projectIdentity: string;
    budgets: AngelScriptLanguageServerBudgets;
    producerCompatibility?: {
        extensionVersionPrefix?: string;
        languageServerCommit?: string;
    };
};

export type AtomicWriteOperations = Pick<typeof fs,
    'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;

function hashChunks(chunks: unknown) : string
{
    return createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
}

const SCRIPT_SETTING_KEYS = [
    'floatIsFloat64',
    'useAngelscriptHaze',
    'deprecateStaticClass',
    'disallowStaticClass',
    'exposeGlobalFunctions',
    'deprecateActorGenerics',
    'disallowActorGenerics',
] as const;

const CACHE_ROOT_KEYS = new Set([
    'schema',
    'version',
    'projectIdentity',
    'revision',
    'contentHash',
    'createdAt',
    'producer',
    'scriptSettings',
    'engineSupportsCreateBlueprint',
    'complete',
    'accessState',
    'debugDatabaseChunks',
    'debugDatabaseAccessChunks',
]);

function validateCreatedAt(value: unknown) : value is string
{
    return typeof value == 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        && new Date(value).toISOString() == value;
}

function validateScriptSettings(value: unknown) : value is Record<string, boolean>
{
    if (!isObject(value) || Object.keys(value).length != SCRIPT_SETTING_KEYS.length)
        return false;
    return SCRIPT_SETTING_KEYS.every((key) => typeof value[key] == 'boolean');
}

function canonicalProducer(value: DebugDatabaseCacheProducer) : DebugDatabaseCacheProducer
{
    return {
        extensionVersion: value.extensionVersion,
        languageServerCommit: value.languageServerCommit,
        ...(value.engineVersion === undefined ? {} : { engineVersion: value.engineVersion }),
        ...(value.pluginVersion === undefined ? {} : { pluginVersion: value.pluginVersion }),
    };
}

function validateProducer(value: unknown) : value is DebugDatabaseCacheProducer
{
    if (!isObject(value)
        || typeof value.extensionVersion != 'string'
        || typeof value.languageServerCommit != 'string'
        || (value.engineVersion !== undefined && typeof value.engineVersion != 'string')
        || (value.pluginVersion !== undefined && typeof value.pluginVersion != 'string'))
        return false;
    let allowed = new Set(['extensionVersion', 'languageServerCommit', 'engineVersion', 'pluginVersion']);
    return Object.keys(value).every((key) => allowed.has(key));
}

function semanticContentHash(value: Pick<DebugDatabaseCacheV2,
    'projectIdentity' | 'producer' | 'scriptSettings' | 'engineSupportsCreateBlueprint' | 'complete' | 'accessState' | 'debugDatabaseChunks' | 'debugDatabaseAccessChunks'>) : string
{
    let canonicalSettings: Record<string, boolean> = {};
    for (let key of SCRIPT_SETTING_KEYS)
        canonicalSettings[key] = value.scriptSettings[key];
    let semanticPayload = {
        projectIdentity: value.projectIdentity,
        producer: canonicalProducer(value.producer),
        scriptSettings: canonicalSettings,
        engineSupportsCreateBlueprint: value.engineSupportsCreateBlueprint,
        complete: value.complete,
        accessState: value.accessState ?? (value.debugDatabaseAccessChunks === undefined ? 'base-only' : 'base+access'),
        debugDatabaseChunks: value.debugDatabaseChunks,
        debugDatabaseAccessChunks: value.debugDatabaseAccessChunks ?? [],
    };
    return createHash('sha256').update(JSON.stringify(semanticPayload)).digest('hex');
}

export function createDebugDatabaseRevision(
    chunks: readonly unknown[],
    accessChunks: readonly unknown[] = [],
) : string
{
    return hashChunks({ chunks, accessChunks });
}

function isObject(value: unknown) : value is Record<string, unknown>
{
    return value != null && typeof value == 'object' && !Array.isArray(value);
}

export function loadDebugDatabaseCacheV2(context: DebugDatabaseCacheContext) : DebugDatabaseCacheLoadResult
{
    let compressed: Buffer;
    try
    {
        let stat = fs.statSync(context.cachePath);
        if (stat.size > context.budgets.maxCompressedBytes)
            return { ok: false, code: 'compressed-budget', message: `Cache exceeds compressed budget (${stat.size} bytes).` };
        compressed = fs.readFileSync(context.cachePath);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException)?.code == 'ENOENT')
            return { ok: false, code: 'missing', message: 'Cache file does not exist.' };
        return { ok: false, code: 'invalid-gzip', message: `Cache read failed: ${String(error)}` };
    }

    let plain: Buffer;
    try
    {
        plain = gunzipSync(compressed, { maxOutputLength: context.budgets.maxUncompressedBytes });
    }
    catch (error)
    {
        let message = String(error);
        let code = message.includes('larger than') || message.includes('maxOutputLength')
            ? 'uncompressed-budget' as const
            : 'invalid-gzip' as const;
        return { ok: false, code, message: `Cache decompression failed: ${message}` };
    }

    let parsed: unknown;
    try
    {
        parsed = JSON.parse(plain.toString('utf8'));
    }
    catch (error)
    {
        return { ok: false, code: 'invalid-json', message: `Cache JSON is invalid: ${String(error)}` };
    }
    if (!isObject(parsed)
        || !Object.keys(parsed).every((key) => CACHE_ROOT_KEYS.has(key))
        || parsed.schema != DEBUG_DATABASE_CACHE_SCHEMA
        || parsed.version != DEBUG_DATABASE_CACHE_VERSION
        || parsed.complete !== true
        || !Array.isArray(parsed.debugDatabaseChunks)
        || (parsed.accessState != 'base-only' && parsed.accessState != 'base+access')
        || typeof parsed.projectIdentity != 'string'
        || typeof parsed.revision != 'string'
        || typeof parsed.contentHash != 'string'
        || !validateCreatedAt(parsed.createdAt)
        || !validateProducer(parsed.producer)
        || !validateScriptSettings(parsed.scriptSettings)
        || typeof parsed.engineSupportsCreateBlueprint != 'boolean')
        return { ok: false, code: 'invalid-schema', message: 'Cache envelope is incomplete or uses an unsupported schema.' };
    if (parsed.projectIdentity !== context.projectIdentity)
        return { ok: false, code: 'identity-mismatch', message: 'Cache project identity does not match this workspace.' };
    if (parsed.debugDatabaseChunks.length > context.budgets.maxChunkCount)
        return { ok: false, code: 'chunk-budget', message: `Cache exceeds chunk budget (${parsed.debugDatabaseChunks.length}).` };
    for (let [chunkIndex, chunk] of parsed.debugDatabaseChunks.entries())
    {
        if (!isObject(chunk) || Object.entries(chunk).some(([name, record]) => name.length == 0 || !isObject(record)))
            return { ok: false, code: 'invalid-schema', message: `Cache contains an invalid DebugDatabase chunk at index ${chunkIndex}.` };
    }
    if (parsed.accessState == 'base-only' && parsed.debugDatabaseAccessChunks !== undefined)
        return { ok: false, code: 'invalid-schema', message: 'Base-only cache cannot contain access records.' };
    if (parsed.accessState == 'base+access' && !Array.isArray(parsed.debugDatabaseAccessChunks))
        return { ok: false, code: 'invalid-schema', message: 'Complete access cache must contain an access record array.' };
    if (parsed.debugDatabaseAccessChunks !== undefined)
    {
        if (!Array.isArray(parsed.debugDatabaseAccessChunks))
            return { ok: false, code: 'invalid-schema', message: 'Cache DebugDatabase access sidecar must be an array.' };
        try
        {
            for (let chunk of parsed.debugDatabaseAccessChunks)
                normalizeDebugDatabaseAccessChunk(chunk);
        }
        catch (error)
        {
            return { ok: false, code: 'invalid-schema', message: `Cache access sidecar validation failed: ${String(error)}` };
        }
    }
    let compatibility = context.producerCompatibility;
    if (compatibility?.extensionVersionPrefix
        && !parsed.producer.extensionVersion.startsWith(compatibility.extensionVersionPrefix))
        return { ok: false, code: 'producer-mismatch', message: 'Cache extension producer is incompatible.' };
    if (compatibility?.languageServerCommit
        && parsed.producer.languageServerCommit != compatibility.languageServerCommit)
        return { ok: false, code: 'producer-mismatch', message: 'Cache Language Server producer is incompatible.' };
    let revision = createDebugDatabaseRevision(
        parsed.debugDatabaseChunks as unknown[],
        (parsed.debugDatabaseAccessChunks as unknown[] | undefined) ?? [],
    );
    let contentHash = semanticContentHash(parsed as DebugDatabaseCacheV2);
    if (contentHash != parsed.contentHash || parsed.revision != revision)
        return { ok: false, code: 'hash-mismatch', message: 'Cache semantic content hash or DebugDatabase revision does not match.' };
    return { ok: true, cache: parsed as DebugDatabaseCacheV2 };
}

function fsyncDirectory(directory: string) : void
{
    let descriptor: number | undefined;
    try
    {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    }
    catch
    {
        // Directory fsync is not supported by every Windows filesystem.
    }
    finally
    {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}

function createCacheEnvelope(
    context: DebugDatabaseCacheContext,
    payload: DebugDatabaseCachePayload,
) : { envelope: DebugDatabaseCacheV2; plain: Buffer }
{
    if (context.access != 'read-write')
        throw new Error('Cache publication is disabled for this Language Server role.');
    if (payload.debugDatabaseChunks.length == 0)
        throw new Error('Refusing to publish an empty debug database cache.');
    if (payload.debugDatabaseChunks.length > context.budgets.maxChunkCount)
        throw new Error(`Debug database exceeds chunk budget (${payload.debugDatabaseChunks.length}).`);
    for (let [chunkIndex, chunk] of payload.debugDatabaseChunks.entries())
    {
        if (!isObject(chunk) || Object.entries(chunk).some(([name, record]) => name.length == 0 || !isObject(record)))
            throw new Error(`Debug database contains an invalid chunk at index ${chunkIndex}.`);
    }
    if (payload.debugDatabaseAccessChunks !== undefined)
    {
        if (!Array.isArray(payload.debugDatabaseAccessChunks))
            throw new Error('Debug database access sidecar must be an array.');
        for (let chunk of payload.debugDatabaseAccessChunks)
            normalizeDebugDatabaseAccessChunk(chunk);
    }
    let accessState = payload.accessState
        ?? (payload.debugDatabaseAccessChunks === undefined ? 'base-only' : 'base+access');
    if (accessState != 'base-only' && accessState != 'base+access')
        throw new Error('Debug database access state must be base-only or base+access.');
    if (accessState == 'base-only' && payload.debugDatabaseAccessChunks !== undefined)
        throw new Error('Base-only debug database cache cannot contain access records.');
    if (accessState == 'base+access' && !Array.isArray(payload.debugDatabaseAccessChunks))
        throw new Error('Complete debug database cache requires access records.');
    if (payload.projectIdentity != context.projectIdentity)
        throw new Error('Debug database project identity does not match the cache context.');
    if (!validateProducer(payload.producer) || !validateScriptSettings(payload.scriptSettings))
        throw new Error('Debug database producer or script settings do not match the closed v2 schema.');

    let revision = createDebugDatabaseRevision(
        payload.debugDatabaseChunks,
        payload.debugDatabaseAccessChunks ?? [],
    );
    let envelope: DebugDatabaseCacheV2 = {
        schema: DEBUG_DATABASE_CACHE_SCHEMA,
        version: DEBUG_DATABASE_CACHE_VERSION,
        revision,
        contentHash: '',
        createdAt: new Date().toISOString(),
        complete: true,
        accessState,
        ...payload,
    };
    envelope.contentHash = semanticContentHash(envelope);
    let plain = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (plain.length > context.budgets.maxUncompressedBytes)
        throw new Error(`Debug database exceeds uncompressed budget (${plain.length}).`);
    return { envelope, plain };
}

export function saveDebugDatabaseCacheV2(
    context: DebugDatabaseCacheContext,
    payload: DebugDatabaseCachePayload,
    operations: AtomicWriteOperations = fs,
) : DebugDatabaseCacheV2
{
    let { envelope, plain } = createCacheEnvelope(context, payload);
    let compressed = gzipSync(plain, { level: 6 });
    if (compressed.length > context.budgets.maxCompressedBytes)
        throw new Error(`Debug database exceeds compressed budget (${compressed.length}).`);

    let directory = path.dirname(context.cachePath);
    fs.mkdirSync(directory, { recursive: true });
    let tempPath = path.join(directory, `.${path.basename(context.cachePath)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try
    {
        descriptor = operations.openSync(tempPath, 'wx');
        operations.writeFileSync(descriptor, compressed);
        operations.fsyncSync(descriptor);
        operations.closeSync(descriptor);
        descriptor = undefined;
        operations.renameSync(tempPath, context.cachePath);
        fsyncDirectory(directory);
    }
    finally
    {
        if (descriptor !== undefined)
        {
            try { operations.closeSync(descriptor); } catch {}
        }
        try { operations.unlinkSync(tempPath); } catch {}
    }
    return envelope;
}

const gzipAsync = promisify(gzip);

export type PreparedDebugDatabaseCacheV2 = {
    tempPath: string;
    envelope: Omit<DebugDatabaseCacheV2, 'debugDatabaseChunks'>;
};

export async function prepareDebugDatabaseCacheV2Temp(
    context: DebugDatabaseCacheContext,
    payload: DebugDatabaseCachePayload,
) : Promise<PreparedDebugDatabaseCacheV2>
{
    let { envelope, plain } = createCacheEnvelope(context, payload);
    let compressed = await gzipAsync(plain, { level: 6 });
    if (compressed.length > context.budgets.maxCompressedBytes)
        throw new Error(`Debug database exceeds compressed budget (${compressed.length}).`);

    let directory = path.dirname(context.cachePath);
    await fs.promises.mkdir(directory, { recursive: true });
    let tempPath = path.join(directory, `.${path.basename(context.cachePath)}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try
    {
        handle = await fs.promises.open(tempPath, 'wx');
        await handle.writeFile(compressed);
        await handle.sync();
        await handle.close();
        handle = undefined;

        let tempReadback = loadDebugDatabaseCacheV2({ ...context, cachePath: tempPath });
        if (tempReadback.ok === false)
            throw new Error(`Temporary cache readback verification failed: ${tempReadback.message}`);
        if (tempReadback.cache.revision != envelope.revision
            || tempReadback.cache.contentHash != envelope.contentHash)
            throw new Error('Temporary cache readback verification failed: content mismatch');
        let { debugDatabaseChunks: _chunks, debugDatabaseAccessChunks: _accessChunks, ...metadata } = envelope;
        return { tempPath, envelope: metadata };
    }
    catch (error)
    {
        await handle?.close().catch(() => {});
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
    }
}

type CachePreparationWorkerResponse =
    | { ok: true; prepared: PreparedDebugDatabaseCacheV2 }
    | { ok: false; error: string };

export type AsyncCacheCommitOperations = {
    rename: (from: string, to: string) => void;
    openDirectory: (directory: string) => Promise<{
        sync: () => Promise<void>;
        close: () => Promise<void>;
    }>;
    unlink: (target: string) => Promise<void>;
};

const DEFAULT_ASYNC_COMMIT_OPERATIONS: AsyncCacheCommitOperations = {
    rename: fs.renameSync,
    openDirectory: (directory) => fs.promises.open(directory, 'r'),
    unlink: (target) => fs.promises.unlink(target),
};

function resolveCachePreparationWorkerPath() : string
{
    let candidates = [
        path.join(__dirname, 'debug-database-cache-worker.js'),
        path.resolve(__dirname, '..', 'dist', 'debug-database-cache-worker.js'),
    ];
    let resolved = candidates.find((candidate) => fs.existsSync(candidate));
    if (!resolved)
        throw new Error('DebugDatabase cache preparation worker bundle is missing.');
    return resolved;
}

function prepareCacheInWorker(
    context: DebugDatabaseCacheContext,
    payload: DebugDatabaseCachePayload,
) : Promise<PreparedDebugDatabaseCacheV2>
{
    return new Promise((resolve, reject) => {
        let worker = new Worker(resolveCachePreparationWorkerPath(), {
            workerData: { context, payload },
        });
        let settled = false;
        worker.once('message', (response: CachePreparationWorkerResponse) => {
            settled = true;
            if (response.ok === true)
                resolve(response.prepared);
            else
                reject(new Error(response.error));
        });
        worker.once('error', (error) => {
            settled = true;
            reject(error);
        });
        worker.once('exit', (code) => {
            if (!settled && code != 0)
                reject(new Error(`DebugDatabase cache preparation worker exited with code ${code}.`));
            else if (!settled)
                reject(new Error('DebugDatabase cache preparation worker exited without a result.'));
        });
    });
}

export async function saveDebugDatabaseCacheV2Async(
    context: DebugDatabaseCacheContext,
    payload: DebugDatabaseCachePayload,
    shouldCommit: () => boolean = () => true,
) : Promise<DebugDatabaseCacheV2>
{
    let prepared = await prepareCacheInWorker(context, payload);
    await commitPreparedDebugDatabaseCacheV2(prepared, context, shouldCommit);
    return {
        ...prepared.envelope,
        debugDatabaseChunks: payload.debugDatabaseChunks,
        ...(payload.debugDatabaseAccessChunks === undefined ? {} : {
            debugDatabaseAccessChunks: payload.debugDatabaseAccessChunks,
        }),
    };
}

export async function commitPreparedDebugDatabaseCacheV2(
    prepared: PreparedDebugDatabaseCacheV2,
    context: DebugDatabaseCacheContext,
    shouldCommit: () => boolean,
    operations: AsyncCacheCommitOperations = DEFAULT_ASYNC_COMMIT_OPERATIONS,
) : Promise<void>
{
    try
    {
        if (!shouldCommit())
            throw new Error('DebugDatabase cache publication was superseded before atomic replace.');
        operations.rename(prepared.tempPath, context.cachePath);
        let directoryHandle: Awaited<ReturnType<AsyncCacheCommitOperations['openDirectory']>> | undefined;
        try
        {
            directoryHandle = await operations.openDirectory(path.dirname(context.cachePath));
            await directoryHandle.sync();
        }
        catch
        {
            // Directory fsync is not supported by every Windows filesystem.
        }
        finally
        {
            await directoryHandle?.close();
        }
    }
    finally
    {
        await operations.unlink(prepared.tempPath).catch(() => {});
    }
}
