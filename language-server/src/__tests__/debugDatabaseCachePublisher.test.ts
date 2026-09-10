import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDebugDatabaseCachePublisher, DebugDatabaseCachePublication } from '../debugDatabaseCachePublisher';
import {
    DebugDatabaseCacheV2,
    createDebugDatabaseRevision,
    loadDebugDatabaseCacheV2,
    saveDebugDatabaseCacheV2,
    saveDebugDatabaseCacheV2Async,
} from '../debugDatabaseCacheV2';
import { DEFAULT_LANGUAGE_SERVER_BUDGETS } from '../languageServerContract';
import { createUnrealCacheController } from '../unrealCacheController';
import { GetTypeByName, ResetDatabaseForTests } from '../database';

function nativeType(name: string) : Record<string, unknown>
{
    return { [name]: { properties: {}, methods: {} } };
}

function fakeCache(revision: string) : DebugDatabaseCacheV2
{
    return {
        schema: 'unreal-angelscript-debug-database',
        version: 3,
        projectIdentity: 'publisher-test',
        revision,
        contentHash: revision,
        createdAt: new Date(0).toISOString(),
        producer: { extensionVersion: 'test', languageServerCommit: 'test' },
        scriptSettings: {
            floatIsFloat64: false,
            useAngelscriptHaze: false,
            deprecateStaticClass: false,
            disallowStaticClass: false,
            exposeGlobalFunctions: false,
            deprecateActorGenerics: false,
            disallowActorGenerics: false,
        },
        engineSupportsCreateBlueprint: false,
        complete: true,
        debugDatabaseChunks: [nativeType(revision)],
    };
}

function publication(
    generation: number,
    revision: string,
    publish: DebugDatabaseCachePublication['publish'],
) : DebugDatabaseCachePublication
{
    return { generation, revision, publish };
}

test('publisher retries transient failures and becomes clean after recovery', async () => {
    let attempts = 0;
    let publisher = createDebugDatabaseCachePublisher({ retryDelaysMs: [1, 1, 1] });
    publisher.setInitialState('missing');
    publisher.submit(publication(1, 'A', async () => {
        attempts += 1;
        if (attempts < 3)
            throw new Error('transient');
        return fakeCache('A');
    }));
    assert.equal(await publisher.flush(1000), true);
    assert.equal(attempts, 3);
    assert.deepEqual(publisher.snapshot(), {
        state: 'clean',
        cacheDirty: false,
        persistenceAttempt: 3,
        activeRevision: 'A',
        persistedRevision: 'A',
        pendingRevision: undefined,
        lastPersistenceError: undefined,
    });
});

test('publisher stops after the initial write and three bounded retries', async () => {
    let attempts = 0;
    let publisher = createDebugDatabaseCachePublisher({ retryDelaysMs: [1, 1, 1] });
    publisher.setInitialState('missing');
    publisher.submit(publication(1, 'A', async () => {
        attempts += 1;
        throw new Error('permanent');
    }));
    assert.equal(await publisher.flush(1000), false);
    assert.equal(attempts, 4);
    assert.equal(publisher.snapshot().state, 'error');
    assert.equal(publisher.snapshot().cacheDirty, true);
    assert.match(publisher.snapshot().lastPersistenceError ?? '', /permanent/);
});

test('new generations interrupt stale backoff and coalesce to the latest complete generation', async () => {
    let calls: string[] = [];
    let publisher = createDebugDatabaseCachePublisher({ retryDelaysMs: [1000, 1000, 1000] });
    publisher.setInitialState('missing');
    publisher.submit(publication(1, 'A', async () => {
        calls.push('A');
        throw new Error('A failed');
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    publisher.submit(publication(2, 'B', async () => {
        calls.push('B');
        return fakeCache('B');
    }));
    publisher.submit(publication(3, 'C', async () => {
        calls.push('C');
        return fakeCache('C');
    }));
    assert.equal(await publisher.flush(1000), true);
    assert.deepEqual(calls, ['A', 'C']);
    assert.equal(publisher.snapshot().persistedRevision, 'C');
    assert.equal(publisher.snapshot().activeRevision, 'C');
    assert.equal(publisher.snapshot().state, 'clean');
});

test('a newer generation is published even when its chunk revision is unchanged', async () => {
    let generations: number[] = [];
    let publisher = createDebugDatabaseCachePublisher({ retryDelaysMs: [] });
    publisher.setInitialState('missing');
    publisher.submit(publication(1, 'same-revision', async () => {
        generations.push(1);
        return fakeCache('same-revision');
    }));
    assert.equal(await publisher.flush(100), true);
    publisher.submit(publication(2, 'same-revision', async () => {
        generations.push(2);
        return fakeCache('same-revision');
    }));
    assert.equal(await publisher.flush(100), true);
    assert.deepEqual(generations, [1, 2]);
    assert.equal(publisher.snapshot().persistenceAttempt, 1);
});

test('shutdown drains a completing latest write and times out a hung writer', async () => {
    let release: (() => void) | undefined;
    let completing = createDebugDatabaseCachePublisher({ retryDelaysMs: [] });
    completing.setInitialState('missing');
    completing.submit(publication(1, 'A', async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return fakeCache('A');
    }));
    setTimeout(() => release?.(), 5);
    assert.equal(await completing.shutdown(100), true);

    let hung = createDebugDatabaseCachePublisher({ retryDelaysMs: [] });
    hung.setInitialState('missing');
    hung.submit(publication(1, 'H', async () => new Promise<DebugDatabaseCacheV2>(() => {})));
    let started = Date.now();
    assert.equal(await hung.shutdown(20), false);
    assert.ok(Date.now() - started < 200);
    assert.equal(hung.snapshot().cacheDirty, true);
});

test('shutdown bounded flush retries a dirty generation that exhausted active retries', async () => {
    let fail = true;
    let attempts = 0;
    let publisher = createDebugDatabaseCachePublisher({ retryDelaysMs: [] });
    publisher.setInitialState('missing');
    publisher.submit(publication(1, 'A', async () => {
        attempts += 1;
        if (fail)
            throw new Error('first pass failed');
        return fakeCache('A');
    }));
    assert.equal(await publisher.flush(100), false);
    assert.equal(publisher.snapshot().state, 'error');
    fail = false;
    assert.equal(await publisher.shutdown(100), true);
    assert.equal(attempts, 2);
    assert.equal(publisher.snapshot().state, 'clean');
});

test('memory acceptance is immediate while persistence is slow', async () => {
    ResetDatabaseForTests();
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-memory-first-'));
    let cachePath = path.join(directory, 'debug-database.v2.json.gz');
    let context = {
        cachePath,
        access: 'read-write' as const,
        projectIdentity: 'memory-first-project',
        budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
    };
    let producer = { extensionVersion: 'test', languageServerCommit: 'test' };
    let settings = {
        floatIsFloat64: false,
        useAngelscriptHaze: false,
        deprecateStaticClass: false,
        disallowStaticClass: false,
        exposeGlobalFunctions: false,
        deprecateActorGenerics: false,
        disallowActorGenerics: false,
    };
    let old = saveDebugDatabaseCacheV2(context, {
        projectIdentity: context.projectIdentity,
        producer,
        scriptSettings: settings,
        engineSupportsCreateBlueprint: false,
        debugDatabaseChunks: [nativeType('UOldPersisted')],
    });
    let release: (() => void) | undefined;
    let controller = createUnrealCacheController({
        publishCache: async (publishContext, payload, shouldCommit) => {
            await new Promise<void>((resolve) => { release = resolve; });
            return saveDebugDatabaseCacheV2Async(publishContext, payload, shouldCommit);
        },
        publisherRetryDelaysMs: [],
    });
    controller.configure(context, producer);
    assert.equal(controller.loadCacheFromDisk().loaded, true);
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UNewActive'));
    let accepted = controller.acceptCompleteCandidate();
    assert.ok(GetTypeByName('UNewActive'));
    assert.equal(GetTypeByName('UOldPersisted') == null, true);
    assert.equal(controller.getPersistenceStatus().activeRevision, accepted.revision);
    assert.equal(controller.getPersistenceStatus().persistedRevision, old.revision);
    assert.equal(controller.getPersistenceStatus().cacheDirty, true);
    let stillOld = loadDebugDatabaseCacheV2(context);
    assert.equal(stillOld.ok && stillOld.cache.revision, old.revision);
    release?.();
    assert.equal(await controller.flushPersistence(1000), true);
    assert.equal(controller.getPersistenceStatus().persistedRevision, accepted.revision);
    await controller.shutdownPersistence(100);
    fs.rmSync(directory, { recursive: true, force: true });
});

test('permanent publication failure keeps new active memory and the old final cache', async () => {
    ResetDatabaseForTests();
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-memory-dirty-'));
    let cachePath = path.join(directory, 'debug-database.v2.json.gz');
    let context = {
        cachePath,
        access: 'read-write' as const,
        projectIdentity: 'memory-dirty-project',
        budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
    };
    let producer = { extensionVersion: 'test', languageServerCommit: 'test' };
    let settings = {
        floatIsFloat64: false,
        useAngelscriptHaze: false,
        deprecateStaticClass: false,
        disallowStaticClass: false,
        exposeGlobalFunctions: false,
        deprecateActorGenerics: false,
        disallowActorGenerics: false,
    };
    let old = saveDebugDatabaseCacheV2(context, {
        projectIdentity: context.projectIdentity,
        producer,
        scriptSettings: settings,
        engineSupportsCreateBlueprint: false,
        debugDatabaseChunks: [nativeType('UOldDiskAuthority')],
    });
    let attempts = 0;
    let controller = createUnrealCacheController({
        publishCache: async () => {
            attempts += 1;
            throw new Error('disk unavailable');
        },
        publisherRetryDelaysMs: [1, 1, 1],
    });
    controller.configure(context, producer);
    assert.equal(controller.loadCacheFromDisk().loaded, true);
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UNewMemoryAuthority'));
    let accepted = controller.acceptCompleteCandidate();
    assert.ok(GetTypeByName('UNewMemoryAuthority'));
    assert.equal(await controller.flushPersistence(1000), false);
    assert.equal(attempts, 4);
    let status = controller.getPersistenceStatus();
    assert.equal(status.activeRevision, accepted.revision);
    assert.equal(status.persistedRevision, old.revision);
    assert.equal(status.state, 'error');
    assert.equal(status.cacheDirty, true);
    assert.match(status.lastPersistenceError ?? '', /disk unavailable/);
    let disk = loadDebugDatabaseCacheV2(context);
    assert.equal(disk.ok && disk.cache.revision, old.revision);
    fs.rmSync(directory, { recursive: true, force: true });
});

test('stale atomic publication guard leaves the previous final untouched', async () => {
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-stale-publish-'));
    let cachePath = path.join(directory, 'debug-database.v2.json.gz');
    let context = {
        cachePath,
        access: 'read-write' as const,
        projectIdentity: 'stale-project',
        budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
    };
    let producer = { extensionVersion: 'test', languageServerCommit: 'test' };
    let settings = {
        floatIsFloat64: false,
        useAngelscriptHaze: false,
        deprecateStaticClass: false,
        disallowStaticClass: false,
        exposeGlobalFunctions: false,
        deprecateActorGenerics: false,
        disallowActorGenerics: false,
    };
    let old = saveDebugDatabaseCacheV2(context, {
        projectIdentity: context.projectIdentity,
        producer,
        scriptSettings: settings,
        engineSupportsCreateBlueprint: false,
        debugDatabaseChunks: [nativeType('UOldFinal')],
    });
    await assert.rejects(saveDebugDatabaseCacheV2Async(context, {
        projectIdentity: context.projectIdentity,
        producer,
        scriptSettings: settings,
        engineSupportsCreateBlueprint: false,
        debugDatabaseChunks: [nativeType('UStaleCandidate')],
    }, () => false), /superseded/);
    let loaded = loadDebugDatabaseCacheV2(context);
    assert.equal(loaded.ok && loaded.cache.revision, old.revision);
    assert.equal(createDebugDatabaseRevision([nativeType('UStaleCandidate')]) == old.revision, false);
    fs.rmSync(directory, { recursive: true, force: true });
});

test('real large-cache preparation keeps status polling responsive on the main event loop', { timeout: 30000 }, async () => {
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-worker-latency-'));
    let context = {
        cachePath: path.join(directory, 'debug-database.v2.json.gz'),
        access: 'read-write' as const,
        projectIdentity: 'latency-project',
        budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
    };
    let chunks = [{ ULatencyFixture: { documentation: 'x'.repeat(16 * 1024 * 1024) } }];
    let revision = createDebugDatabaseRevision(chunks);
    let publisher = createDebugDatabaseCachePublisher({ retryDelaysMs: [] });
    publisher.setInitialState('missing');
    let sampleCount = 0;
    let maxDelay = 0;
    let previous = performance.now();
    let heartbeat = setInterval(() => {
        let now = performance.now();
        maxDelay = Math.max(maxDelay, now - previous);
        previous = now;
        publisher.snapshot();
        sampleCount += 1;
    }, 5);
    try
    {
        publisher.submit(publication(1, revision, (isCurrent) => saveDebugDatabaseCacheV2Async(context, {
            projectIdentity: context.projectIdentity,
            producer: { extensionVersion: 'test', languageServerCommit: 'test' },
            scriptSettings: {
                floatIsFloat64: false,
                useAngelscriptHaze: false,
                deprecateStaticClass: false,
                disallowStaticClass: false,
                exposeGlobalFunctions: false,
                deprecateActorGenerics: false,
                disallowActorGenerics: false,
            },
            engineSupportsCreateBlueprint: false,
            debugDatabaseChunks: chunks,
        }, isCurrent)));
        assert.equal(await publisher.flush(20000), true);
        assert.ok(sampleCount >= 3, `Expected status polling during publication, observed ${sampleCount} samples.`);
        assert.ok(maxDelay < 250, `Large-cache publication blocked the main event loop for ${maxDelay.toFixed(1)} ms.`);
    }
    finally
    {
        clearInterval(heartbeat);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
