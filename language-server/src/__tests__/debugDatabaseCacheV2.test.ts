import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
    loadDebugDatabaseCacheV2,
    commitPreparedDebugDatabaseCacheV2,
    saveDebugDatabaseCacheV2,
    type AtomicWriteOperations,
    type DebugDatabaseCacheContext,
} from '../debugDatabaseCacheV2';
import { DEFAULT_LANGUAGE_SERVER_BUDGETS } from '../languageServerContract';

function withTempDir(run: (directory: string) => void) : void
{
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-ls-cache-v2-'));
    try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function makeContext(directory: string, overrides: Partial<DebugDatabaseCacheContext> = {}) : DebugDatabaseCacheContext
{
    return {
        cachePath: path.join(directory, 'debug-database.v2.json.gz'),
        access: 'read-write',
        projectIdentity: 'project-a',
        budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
        ...overrides,
    };
}

function scriptSettings(floatIsFloat64 = false) : Record<string, boolean>
{
    return {
        floatIsFloat64,
        useAngelscriptHaze: false,
        deprecateStaticClass: false,
        disallowStaticClass: false,
        exposeGlobalFunctions: false,
        deprecateActorGenerics: false,
        disallowActorGenerics: false,
    };
}

function failingOperations(stage: 'write' | 'fsync') : AtomicWriteOperations
{
    return {
        openSync: fs.openSync,
        writeFileSync: (stage == 'write' ? (() => { throw new Error('injected write failure'); }) : fs.writeFileSync) as typeof fs.writeFileSync,
        fsyncSync: (stage == 'fsync' ? (() => { throw new Error('injected fsync failure'); }) : fs.fsyncSync) as typeof fs.fsyncSync,
        closeSync: fs.closeSync,
        renameSync: fs.renameSync,
        unlinkSync: fs.unlinkSync,
    };
}

test('debug database cache v2 round-trips ordered chunks and atomically replaces the prior revision', () => {
    withTempDir((directory) => {
        let context = makeContext(directory);
        let first = saveDebugDatabaseCacheV2(context, {
            projectIdentity: 'project-a',
            producer: { extensionVersion: '1.9.3070', languageServerCommit: 'abc' },
            scriptSettings: scriptSettings(true),
            engineSupportsCreateBlueprint: true,
            debugDatabaseChunks: [{ USecond: { id: 2 } }, { UFirst: { id: 1 } }],
        });
        let second = saveDebugDatabaseCacheV2(context, {
            projectIdentity: 'project-a',
            producer: { extensionVersion: '1.9.3070', languageServerCommit: 'abc' },
            scriptSettings: scriptSettings(false),
            engineSupportsCreateBlueprint: false,
            debugDatabaseChunks: [{ UThird: { id: 3 } }],
        });
        assert.notEqual(first.revision, second.revision);
        let loaded = loadDebugDatabaseCacheV2(context);
        assert.equal(loaded.ok, true);
        if (loaded.ok)
            assert.deepEqual(loaded.cache.debugDatabaseChunks, [{ UThird: { id: 3 } }]);
        assert.deepEqual(fs.readdirSync(directory), ['debug-database.v2.json.gz']);
    });
});

test('debug database cache v2 rejects identity mismatch, corruption, and size budgets', () => {
    withTempDir((directory) => {
        let context = makeContext(directory);
        saveDebugDatabaseCacheV2(context, {
            projectIdentity: 'project-a',
            producer: { extensionVersion: '1.9.3070', languageServerCommit: 'abc' },
            scriptSettings: scriptSettings(),
            engineSupportsCreateBlueprint: false,
            debugDatabaseChunks: [{ AActor: { type: 'AActor' } }],
        });
        let identity = loadDebugDatabaseCacheV2({ ...context, projectIdentity: 'project-b' });
        assert.equal(identity.ok, false);
        if (!identity.ok)
            assert.equal(identity.code, 'identity-mismatch');

        let producer = loadDebugDatabaseCacheV2({
            ...context,
            producerCompatibility: { languageServerCommit: 'different' },
        });
        assert.equal(producer.ok, false);
        if (!producer.ok)
            assert.equal(producer.code, 'producer-mismatch');

        fs.writeFileSync(context.cachePath, Buffer.from('not-gzip'));
        let corrupt = loadDebugDatabaseCacheV2(context);
        assert.equal(corrupt.ok, false);
        if (!corrupt.ok)
            assert.equal(corrupt.code, 'invalid-gzip');

        fs.writeFileSync(context.cachePath, gzipSync(Buffer.from('x'.repeat(4096))));
        let budget = loadDebugDatabaseCacheV2({
            ...context,
            budgets: { ...context.budgets, maxUncompressedBytes: 64 },
        });
        assert.equal(budget.ok, false);
        if (!budget.ok)
            assert.equal(budget.code, 'uncompressed-budget');
    });
});

test('semantic content hash rejects script settings and Blueprint support tampering', () => {
    withTempDir((directory) => {
        let context = makeContext(directory);
        saveDebugDatabaseCacheV2(context, {
            projectIdentity: 'project-a',
            producer: { extensionVersion: '1.9.3072', languageServerCommit: 'abc' },
            scriptSettings: scriptSettings(),
            engineSupportsCreateBlueprint: false,
            debugDatabaseChunks: [{ AActor: {} }],
        });
        let parsed = JSON.parse(gunzipSync(fs.readFileSync(context.cachePath)).toString('utf8'));
        parsed.scriptSettings.floatIsFloat64 = true;
        parsed.engineSupportsCreateBlueprint = true;
        fs.writeFileSync(context.cachePath, gzipSync(Buffer.from(JSON.stringify(parsed))));
        let loaded = loadDebugDatabaseCacheV2(context);
        assert.equal(loaded.ok, false);
        if (!loaded.ok)
            assert.equal(loaded.code, 'hash-mismatch');
    });
});

test('debug database cache v2 rejects unknown root fields and non-canonical timestamps', () => {
    withTempDir((directory) => {
        let context = makeContext(directory);
        saveDebugDatabaseCacheV2(context, {
            projectIdentity: 'project-a',
            producer: { extensionVersion: '1.9.3072', languageServerCommit: 'abc' },
            scriptSettings: scriptSettings(),
            engineSupportsCreateBlueprint: false,
            debugDatabaseChunks: [{ AActor: {} }],
        });
        let original = JSON.parse(gunzipSync(fs.readFileSync(context.cachePath)).toString('utf8'));
        for (let mutate of [
            (value: Record<string, unknown>) => { value.unknownRootField = true; },
            (value: Record<string, unknown>) => { value.createdAt = '2026-07-29T00:00:00Z'; },
            (value: Record<string, unknown>) => { value.createdAt = 123; },
        ])
        {
            let tampered = structuredClone(original);
            mutate(tampered);
            fs.writeFileSync(context.cachePath, gzipSync(Buffer.from(JSON.stringify(tampered))));
            let loaded = loadDebugDatabaseCacheV2(context);
            assert.equal(loaded.ok, false);
            if (!loaded.ok)
                assert.equal(loaded.code, 'invalid-schema');
        }
    });
});

test('debug database cache v2 enforces writer ownership', () => {
    withTempDir((directory) => {
        let context = makeContext(directory, { access: 'disabled' });
        assert.throws(() => saveDebugDatabaseCacheV2(context, {
            projectIdentity: 'project-a',
            producer: { extensionVersion: '1.9.3070', languageServerCommit: 'abc' },
            scriptSettings: scriptSettings(),
            engineSupportsCreateBlueprint: false,
            debugDatabaseChunks: [{ AActor: {} }],
        }), /disabled/);
    });
});

test('debug database atomic writer cleans GUID temp files after write and fsync failures', () => {
    for (let stage of ['write', 'fsync'] as const)
    {
        withTempDir((directory) => {
            let context = makeContext(directory);
            assert.throws(() => saveDebugDatabaseCacheV2(context, {
                projectIdentity: 'project-a',
                producer: { extensionVersion: '1.9.3070', languageServerCommit: 'abc' },
                scriptSettings: scriptSettings(),
                engineSupportsCreateBlueprint: false,
                debugDatabaseChunks: [{ AActor: {} }],
            }, failingOperations(stage)), new RegExp(`injected ${stage} failure`));
            assert.deepEqual(fs.readdirSync(directory), []);
        });
    }
});

test('async publication checks the token, atomically renames, and fsyncs the parent before reporting success', async () => {
    let events: string[] = [];
    let context = makeContext('C:\\cache-root');
    await commitPreparedDebugDatabaseCacheV2({
        tempPath: 'prepared.tmp',
        envelope: {
            schema: 'unreal-angelscript-debug-database',
            version: 3,
            projectIdentity: 'project-a',
            revision: 'revision',
            contentHash: 'content',
            createdAt: '2026-07-29T00:00:00.000Z',
            producer: { extensionVersion: 'test', languageServerCommit: 'test' },
            scriptSettings: scriptSettings(),
            engineSupportsCreateBlueprint: false,
            complete: true,
        },
    }, context, () => { events.push('token'); return true; }, {
        rename() { events.push('rename'); },
        async openDirectory() {
            events.push('open-directory');
            return {
                async sync() { events.push('fsync-directory'); },
                async close() { events.push('close-directory'); },
            };
        },
        async unlink() { events.push('cleanup-temp'); },
    });
    assert.deepEqual(events, [
        'token',
        'rename',
        'open-directory',
        'fsync-directory',
        'close-directory',
        'cleanup-temp',
    ]);
});
