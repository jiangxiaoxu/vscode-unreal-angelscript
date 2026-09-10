import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLanguageServerReadinessController } from '../languageServerReadiness';
import { createUnrealCacheController } from '../unrealCacheController';
import { DEFAULT_LANGUAGE_SERVER_BUDGETS } from '../languageServerContract';
import { loadDebugDatabaseCacheV2, saveDebugDatabaseCacheV2, saveDebugDatabaseCacheV2Async } from '../debugDatabaseCacheV2';
import { AddTypeToDatabase, DBType, GetRootNamespace, GetTypeByName, ResetDatabaseForTests } from '../database';
import * as scriptfiles from '../as_parser';
import { resetTypeDatabaseForGeneration } from '../typeDatabaseGeneration';
import { Complete } from '../parsed_completion';
import { ResolveSymbolAtPosition } from '../symbols';
import { URI } from 'vscode-uri';
import { createLanguageServerAutomationRuntime } from '../languageServerAutomationRuntime';
import { createActiveWorkTracker } from '../activeWorkTracker';

function nativeType(name: string, methodName?: string) : Record<string, unknown>
{
    return {
        [name]: {
            properties: {},
            methods: methodName ? { [methodName]: { name: methodName, return: 'void', args: [] } } : {},
        },
    };
}

test('beginRefresh atomically revokes ready coverage and the prior revision', () => {
    let notifications: unknown[] = [];
    let readiness = createLanguageServerReadinessController((status) => notifications.push(status));
    readiness.update({ generation: 3, stage: 'ready', fullReady: true, coverage: 'full', activeRevision: 'old' });
    readiness.beginRefresh(4);
    assert.deepEqual(readiness.snapshot(), {
        generation: 4,
        semanticGeneration: 1,
        settledSemanticGeneration: 0,
        stage: 'loading-cache',
        fullReady: false,
        coverage: 'none',
        unrealOnline: false,
        unrealConnected: false,
        editorProcessId: undefined,
        cacheState: 'not-checked',
        cacheDirty: false,
        persistenceAttempt: 0,
        cacheMessage: undefined,
        activeRevision: undefined,
    });
    assert.equal(notifications.length, 2);
});

test('optional access sidecar is committed atomically with the base generation', async () => {
    ResetDatabaseForTests();
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-ls-access-phases-'));
    try
    {
        let cachePath = path.join(directory, 'debug-database.v2.json.gz');
        let controller = createUnrealCacheController({ publisherRetryDelaysMs: [] });
        controller.configure({
            cachePath,
            access: 'read-write',
            projectIdentity: directory,
            budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
        }, { extensionVersion: '1.9.3079', languageServerCommit: 'development' });
        let generation = controller.beginRefresh();
        controller.setDebugDatabaseAccessExpected(true);
        assert.equal(controller.getDebugDatabaseAccessReadiness(), 'pending');
        controller.recordDebugDatabaseAccessChunk({
            properties: [{
                owner: 'UBasePhase',
                name: 'Value',
                access: {
                    read: { normal: 'allow', restricted: 'allow' },
                    write: { normal: 'allow', restricted: 'allow' },
                },
            }],
        });
        controller.finishDebugDatabaseAccess();
        controller.recordDebugDatabaseChunk(nativeType('UBasePhase'));
        let accepted = controller.acceptCompleteCandidate();
        assert.equal(accepted.generation, generation);
        assert.equal(controller.getDebugDatabaseAccessReadiness(), 'complete');
        assert.equal(await controller.flushPersistence(5000), true);
        let loaded = loadDebugDatabaseCacheV2({
            cachePath,
            access: 'read-write',
            projectIdentity: directory,
            budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
        });
        assert.equal(loaded.ok, true);
        if (loaded.ok)
            assert.equal(loaded.cache.accessState, 'base+access');
        await controller.shutdownPersistence(1000);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('base-only refresh stays full-ready when the Engine omits optional access', () => {
    ResetDatabaseForTests();
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {}, warn() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3079');
    runtime.beginLiveRefresh();
    runtime.cache.recordDebugDatabaseChunk(nativeType('UBaseOnly'));
    let accepted = runtime.commitLiveRefresh();
    runtime.completeNativeRefresh(accepted.generation);
    runtime.markCurrentGenerationFullReady();
    let status = runtime.readiness.snapshot();
    assert.equal(status.generation, accepted.generation);
    assert.equal(status.fullReady, true);
    assert.equal(runtime.cache.getDebugDatabaseAccessReadiness(), 'base-only');
});

test('optional access enrichment keeps the base semantic generation and diagnostics', () => {
    ResetDatabaseForTests();
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {}, warn() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3079');
    runtime.beginLiveRefresh();
    runtime.cache.setDebugDatabaseAccessExpected(true);
    runtime.cache.recordDebugDatabaseAccessChunk({
        properties: [{
            owner: 'UEnriched',
            name: 'Value',
            access: {
                read: { normal: 'allow', restricted: 'allow' },
                write: { normal: 'allow', restricted: 'allow' },
            },
        }],
    });
    runtime.cache.finishDebugDatabaseAccess();
    runtime.cache.recordDebugDatabaseChunk(nativeType('UEnriched'));
    let accepted = runtime.commitLiveRefresh();
    let diagnostic = {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: 'base diagnostic',
        severity: 1,
    } as any;
    runtime.updateDiagnostics('file:///Enriched.as', [diagnostic]);
    assert.equal(runtime.cache.getDebugDatabaseAccessReadiness(), 'complete');
    assert.equal(runtime.cache.getGeneration(), accepted.generation);
    runtime.completeNativeRefresh(accepted.generation);
    runtime.markCurrentGenerationFullReady();
    let report = runtime.getWorkspaceDiagnosticsReport();
    assert.ok(report.items[0] && 'items' in report.items[0]);
    if (report.items[0] && 'items' in report.items[0])
        assert.equal(report.items[0].items[0]?.message, 'base diagnostic');
    assert.equal(runtime.readiness.snapshot().fullReady, true);
    assert.equal(runtime.readiness.snapshot().generation, accepted.generation);
});

test('semantic generations remain unsettled until parsing and resolution explicitly finish', () => {
    let readiness = createLanguageServerReadinessController(() => {});
    readiness.markFullReady();
    assert.equal(readiness.snapshot().semanticGeneration, 0);
    assert.equal(readiness.snapshot().settledSemanticGeneration, 0);

    assert.equal(readiness.beginSemanticRefresh(), 1);
    assert.deepEqual(readiness.snapshot(), {
        generation: 0,
        semanticGeneration: 1,
        settledSemanticGeneration: 0,
        stage: 'parsing',
        fullReady: false,
        coverage: 'none',
        unrealOnline: false,
        unrealConnected: false,
        editorProcessId: undefined,
        cacheState: 'not-checked',
        cacheDirty: false,
        persistenceAttempt: 0,
    });

    readiness.markFullReady();
    assert.equal(readiness.snapshot().fullReady, true);
    assert.equal(readiness.snapshot().semanticGeneration, 1);
    assert.equal(readiness.snapshot().settledSemanticGeneration, 1);
    assert.throws(() => readiness.update({ semanticGeneration: 0 }), /cannot move backwards/);

    readiness.beginSemanticRefresh();
    assert.throws(() => readiness.update({ fullReady: true }), /requires a settled semantic generation/);

    readiness.markPartialReady('Parsing is still in progress.', false);
    assert.equal(readiness.snapshot().stage, 'partial');
    assert.ok(readiness.snapshot().semanticGeneration > readiness.snapshot().settledSemanticGeneration);
    readiness.markPartialReady('Parsing completed.');
    assert.equal(readiness.snapshot().semanticGeneration, readiness.snapshot().settledSemanticGeneration);
});

test('cache publication is fenced by generation and cannot publish mixed chunks', async () => {
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-ls-generation-'));
    let cachePath = path.join(directory, 'Saved', 'ASEditorAutomation', 'LanguageServer', 'debug-database.v2.json.gz');
    let context = {
        cachePath,
        access: 'read-write' as const,
        projectIdentity: 'generation-project',
        budgets: { ...DEFAULT_LANGUAGE_SERVER_BUDGETS },
    };
    let controller = createUnrealCacheController();
    controller.configure(context, { extensionVersion: 'test', languageServerCommit: 'test' });
    try
    {
        let generation1 = controller.beginRefresh();
        controller.recordDebugDatabaseChunk(nativeType('UGeneration1'));
        controller.acceptCompleteCandidate();
        let generation2 = controller.beginRefresh();
        assert.equal(generation2, generation1 + 1);
        controller.recordDebugDatabaseChunk(nativeType('UGeneration2First'));
        controller.recordDebugDatabaseChunk(nativeType('UGeneration2Second'));
        controller.setDebugDatabaseAccessExpected(true);
        controller.recordDebugDatabaseAccessChunk({
            properties: [{
                owner: 'UGeneration2First',
                name: 'Value',
                access: {
                    read: { normal: 'allow', restricted: 'allow' },
                    write: { normal: 'allow', restricted: 'allow' },
                },
            }],
        });
        controller.finishDebugDatabaseAccess();
        controller.acceptCompleteCandidate();
        assert.equal(await controller.flushPersistence(5000), true);

        let loaded = loadDebugDatabaseCacheV2(context);
        assert.equal(loaded.ok, true);
        if (loaded.ok)
        {
            assert.deepEqual(loaded.cache.debugDatabaseChunks, [
                nativeType('UGeneration2First'),
                nativeType('UGeneration2Second'),
            ]);
            assert.deepEqual(loaded.cache.debugDatabaseAccessChunks, [{
                properties: [{
                    owner: 'UGeneration2First',
                    name: 'Value',
                    access: {
                        read: { normal: 'allowed', restricted: 'allowed' },
                        write: { normal: 'allowed', restricted: 'allowed' },
                    },
                }],
            }]);
        }
    }
    finally
    {
        await controller.shutdownPersistence(1000);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('VS Code removes the exact legacy v1 file only after a live v2 publication readback', async () => {
    ResetDatabaseForTests();
    let root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-vscode-v2-'));
    let uprojectPath = path.join(root, 'Example.uproject');
    let projectIdentity = process.platform == 'win32' ? uprojectPath.toLowerCase() : uprojectPath;
    let legacyPath = path.join(root, 'Script', '.vscode', 'angelscript', 'unreal-cache.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(uprojectPath, '{}');
    fs.writeFileSync(legacyPath, '{}');
    let warnings: string[] = [];
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {}, warn(value: string) { warnings.push(value); } },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3072');
    try
    {
        runtime.configure({
            additionalScriptRootFolders: [],
            role: 'vscode',
            canonicalProjectRoot: root,
            uprojectPath,
            projectIdentity,
            unrealOnline: true,
            debuggerPort: 27099,
            cachePath: path.join(root, 'Script', '.vscode', 'angelscript', 'debug-database.v2.json.gz'),
            cacheAccess: 'read-write',
            budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
        });
        assert.equal(fs.existsSync(legacyPath), true, 'Startup cache load must not remove v1.');
        runtime.beginLiveRefresh();
        runtime.cache.recordDebugDatabaseChunk(nativeType('UV2Published'));
        runtime.commitLiveRefresh();
        assert.equal(await runtime.cache.flushPersistence(5000), true);
        assert.equal(fs.existsSync(legacyPath), false);
        assert.equal(fs.existsSync(path.join(path.dirname(legacyPath), 'debug-database.v2.json.gz')), true);
        assert.deepEqual(warnings, []);
    }
    finally
    {
        await runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('disconnect abort restores the prior full-ready revision when no live chunks completed', () => {
    ResetDatabaseForTests();
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {}, warn() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3072');
    runtime.cache.beginRefresh();
    runtime.cache.recordDebugDatabaseChunk(nativeType('UPriorAccepted'));
    runtime.cache.acceptCompleteCandidate();
    let priorRevision = runtime.cache.getActiveRevision()!;
    runtime.readiness.update({
        generation: runtime.cache.getGeneration(),
        stage: 'ready',
        fullReady: true,
        coverage: 'full',
        activeRevision: priorRevision,
    });

    runtime.beginLiveRefresh();
    assert.equal(runtime.readiness.snapshot().fullReady, true);
    assert.equal(runtime.abortLiveRefresh('test disconnect'), true);
    let restored = runtime.readiness.snapshot();
    assert.equal(restored.fullReady, true);
    assert.equal(restored.activeRevision, priorRevision);
    assert.equal(restored.unrealConnected, false);
    assert.equal(runtime.nativeRefreshPending, false);
    assert.ok(GetTypeByName('UPriorAccepted'));
});

test('an incomplete timed-out generation is never accepted and a later finished generation can replace it', () => {
    ResetDatabaseForTests();
    let controller = createUnrealCacheController();
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UPriorComplete'));
    controller.acceptCompleteCandidate();
    let priorRevision = controller.getActiveRevision();

    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UPartialMustNotCommit'));
    assert.equal(controller.abortRefresh(), true);
    assert.equal(controller.getActiveRevision(), priorRevision);
    assert.ok(GetTypeByName('UPriorComplete'));
    assert.equal(GetTypeByName('UPartialMustNotCommit') == null, true);

    controller.recordDebugDatabaseChunk(nativeType('UIgnoredAfterAbort'));
    assert.equal(controller.isRefreshInProgress(), false);
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UNextFinished'));
    controller.acceptCompleteCandidate();
    assert.ok(GetTypeByName('UNextFinished'));
    assert.equal(GetTypeByName('UPriorComplete') == null, true);
    assert.equal(GetTypeByName('UIgnoredAfterAbort') == null, true);
});

test('an empty finished candidate closes its transaction and allows the next generation', () => {
    ResetDatabaseForTests();
    let controller = createUnrealCacheController();
    controller.beginRefresh();
    assert.throws(() => controller.acceptCompleteCandidate(), /no chunks/);
    assert.equal(controller.isRefreshInProgress(), false);

    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('URecoveredAfterEmpty'));
    controller.acceptCompleteCandidate();
    assert.ok(GetTypeByName('URecoveredAfterEmpty'));
});

test('live refresh preserves the accepted TypeDB and invalid replacement fully restores script resolution', () => {
    ResetDatabaseForTests();
    scriptfiles.ClearAllResolvedModules();
    let controller = createUnrealCacheController();
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UOldGenerationOnly', 'OldMethod'));
    controller.acceptCompleteCandidate();
    let acceptedRevision = controller.getActiveRevision();

    let content = [
        'void Probe()',
        '{',
        '    UOldGenerationOnly Value;',
        '    Value.OldMethod();',
        '    Value.',
        '}',
    ].join('\n');
    let filePath = path.join(os.tmpdir(), 'GenerationRollbackFixture.as');
    let uri = URI.file(filePath).toString();
    let module = scriptfiles.GetOrCreateModule('GenerationRollbackFixture', filePath, uri);
    scriptfiles.UpdateModuleFromContent(module, content);
    scriptfiles.LoadAndParseModule(module);
    scriptfiles.PostProcessModuleTypes(module);
    scriptfiles.ResolveModule(module);
    let completionPosition = { line: 4, character: '    Value.'.length };
    let referencePosition = { line: 3, character: '    Value.Old'.length };
    assert.ok(Complete(module, completionPosition)?.some((item) => item.label == 'OldMethod'));
    assert.equal(ResolveSymbolAtPosition(module, referencePosition, true).ok, true);

    controller.beginRefresh();
    controller.recordDebugDatabaseChunk(nativeType('UNewGenerationBuffered'));
    assert.ok(GetTypeByName('UOldGenerationOnly'), 'The active generation must remain available while chunks are buffered.');
    assert.equal(GetTypeByName('UNewGenerationBuffered') == null, true);
    assert.ok(Complete(module, completionPosition)?.some((item) => item.label == 'OldMethod'));

    controller.recordDebugDatabaseChunk({ UInvalidReplacement: { properties: { Broken: null }, methods: {} } });
    assert.throws(() => controller.acceptCompleteCandidate());
    assert.equal(controller.getActiveRevision(), acceptedRevision);
    assert.ok(GetTypeByName('UOldGenerationOnly'));
    assert.equal(GetTypeByName('UNewGenerationBuffered') == null, true);
    assert.equal(module.resolved, true);
    assert.ok(Complete(module, completionPosition)?.some((item) => item.label == 'OldMethod'));
    assert.equal(ResolveSymbolAtPosition(module, referencePosition, true).ok, true);
});

test('failed live refresh restores the prior full-ready status and revision', () => {
    ResetDatabaseForTests();
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3070');
    runtime.cache.beginRefresh();
    runtime.cache.recordDebugDatabaseChunk(nativeType('URuntimeAccepted'));
    runtime.cache.acceptCompleteCandidate();
    let revision = runtime.cache.getActiveRevision()!;
    runtime.readiness.update({ generation: 1, stage: 'ready', fullReady: true, coverage: 'full', activeRevision: revision });

    runtime.beginLiveRefresh();
    runtime.cache.recordDebugDatabaseChunk({ UInvalidRuntimeReplacement: { properties: { Broken: null }, methods: {} } });
    let failure: unknown;
    try { runtime.cache.acceptCompleteCandidate(); } catch (error) { failure = error; }
    assert.ok(failure);
    runtime.markHydrationFailed(failure);
    let restored = runtime.readiness.snapshot();
    assert.equal(restored.generation, 2);
    assert.equal(restored.stage, 'ready');
    assert.equal(restored.fullReady, true);
    assert.equal(restored.coverage, 'full');
    assert.equal(restored.unrealConnected, true);
    assert.equal(restored.activeRevision, revision);
});

test('failed candidate does not roll persistence status back over a completed writer', async () => {
    ResetDatabaseForTests();
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-persistence-status-'));
    let release: (() => void) | undefined;
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {}, warn() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3072', {
        publishCache: async (context, payload, shouldCommit) => {
            await new Promise<void>((resolve) => { release = resolve; });
            return saveDebugDatabaseCacheV2Async(context, payload, shouldCommit);
        },
        publisherRetryDelaysMs: [],
    });
    try
    {
        runtime.configure({
            additionalScriptRootFolders: [],
            role: 'project-daemon',
            canonicalProjectRoot: directory,
            uprojectPath: path.join(directory, 'Example.uproject'),
            projectIdentity: 'status-project',
            unrealOnline: true,
            debuggerPort: 27099,
            cachePath: path.join(directory, 'debug-database.v2.json.gz'),
            cacheAccess: 'read-write',
            budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
        });
        runtime.beginLiveRefresh();
        runtime.cache.recordDebugDatabaseChunk(nativeType('UStatusAccepted'));
        let accepted = runtime.commitLiveRefresh();
        runtime.completeNativeRefresh(accepted.generation);
        runtime.markCurrentGenerationFullReady();

        runtime.beginLiveRefresh();
        release?.();
        assert.equal(await runtime.cache.flushPersistence(1000), true);
        runtime.cache.recordDebugDatabaseChunk({ UInvalidStatusCandidate: { properties: { Broken: null }, methods: {} } });
        assert.throws(() => runtime.commitLiveRefresh());

        let status = runtime.readiness.snapshot();
        assert.equal(status.cacheState, 'clean');
        assert.equal(status.cacheDirty, false);
        assert.equal(status.activeRevision, accepted.revision);
        assert.equal(status.persistedRevision, accepted.revision);
        assert.equal(status.fullReady, true);
    }
    finally
    {
        await runtime.shutdown();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('hydration failure without a prior cache does not settle unfinished script parsing', () => {
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3070');
    runtime.beginScriptSemanticRefresh();
    runtime.markHydrationFailed(new Error('invalid initial generation'));
    let status = runtime.readiness.snapshot();
    assert.equal(status.stage, 'partial');
    assert.equal(status.fullReady, false);
    assert.ok(status.semanticGeneration > status.settledSemanticGeneration);
});

test('script changes during a failed native refresh remain fenced until separately settled', () => {
    ResetDatabaseForTests();
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3070');
    runtime.cache.beginRefresh();
    runtime.cache.recordDebugDatabaseChunk(nativeType('UInterleavedAccepted'));
    runtime.cache.acceptCompleteCandidate();
    let revision = runtime.cache.getActiveRevision()!;
    runtime.readiness.update({ generation: 1, stage: 'ready', fullReady: true, coverage: 'full', activeRevision: revision });

    runtime.beginLiveRefresh();
    runtime.beginScriptSemanticRefresh();
    runtime.markCurrentGenerationFullReady();
    assert.equal(runtime.readiness.snapshot().fullReady, false);
    assert.equal(runtime.nativeRefreshPending, true);

    runtime.cache.recordDebugDatabaseChunk({ UInvalidInterleavedReplacement: { properties: { Broken: null }, methods: {} } });
    let failure: unknown;
    try { runtime.cache.acceptCompleteCandidate(); } catch (error) { failure = error; }
    runtime.markHydrationFailed(failure);
    let failed = runtime.readiness.snapshot();
    assert.equal(runtime.nativeRefreshPending, false);
    assert.equal(failed.fullReady, false);
    assert.equal(failed.stage, 'parsing');
    assert.ok(failed.semanticGeneration > failed.settledSemanticGeneration);
    assert.equal(failed.activeRevision, revision);

    runtime.markCurrentGenerationFullReady();
    let settled = runtime.readiness.snapshot();
    assert.equal(settled.fullReady, true);
    assert.equal(settled.semanticGeneration, settled.settledSemanticGeneration);
});

test('a stale re-resolve completion settles work left pending by a failed newer native refresh', () => {
    ResetDatabaseForTests();
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3070');
    runtime.cache.beginRefresh();
    runtime.cache.recordDebugDatabaseChunk(nativeType('UStaleResolveAccepted'));
    runtime.cache.acceptCompleteCandidate();
    let revision = runtime.cache.getActiveRevision()!;
    runtime.readiness.update({ generation: 1, stage: 'ready', fullReady: true, coverage: 'full', activeRevision: revision });

    let settledCount = 0;
    let tracker = createActiveWorkTracker(() => {
        settledCount += 1;
        runtime.markCurrentGenerationFullReady();
    });
    let finishStaleResolve = tracker.begin();

    runtime.beginLiveRefresh();
    runtime.beginScriptSemanticRefresh();
    runtime.cache.recordDebugDatabaseChunk({ UInvalidNewerRefresh: { properties: { Broken: null }, methods: {} } });
    let failure: unknown;
    try { runtime.cache.acceptCompleteCandidate(); } catch (error) { failure = error; }
    runtime.markHydrationFailed(failure);
    assert.equal(runtime.nativeRefreshPending, false);
    assert.equal(runtime.readiness.snapshot().fullReady, false);
    assert.equal(tracker.hasActiveWork(), true);

    finishStaleResolve();
    assert.equal(settledCount, 1);
    assert.equal(tracker.hasActiveWork(), false);
    assert.equal(runtime.readiness.snapshot().fullReady, true);
    assert.equal(runtime.readiness.snapshot().semanticGeneration,
        runtime.readiness.snapshot().settledSemanticGeneration);
    assert.throws(finishStaleResolve, /only be reported once/);
});

test('cached startup refresh failure advances the restored generation and can finish initial readiness', () => {
    ResetDatabaseForTests();
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'as-ls-startup-rollback-'));
    let cachePath = path.join(directory, 'debug-database.v2.json.gz');
    let uprojectPath = path.join(directory, 'Example.uproject');
    let projectIdentity = process.platform == 'win32' ? uprojectPath.toLowerCase() : uprojectPath;
    saveDebugDatabaseCacheV2({
        cachePath,
        access: 'read-write',
        projectIdentity,
        budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
    }, {
        projectIdentity,
        producer: { extensionVersion: '1.9.3070', languageServerCommit: 'development' },
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
        debugDatabaseChunks: [nativeType('UStartupCached')],
    });
    let connection = {
        sendNotification() {},
        onRequest() {},
        languages: { diagnostics: { on() {}, onWorkspace() {} } },
        console: { error() {} },
    } as any;
    let runtime = createLanguageServerAutomationRuntime(connection, '1.9.3070');
    try
    {
        let loaded = runtime.configure({
            additionalScriptRootFolders: [],
            role: 'project-daemon',
            canonicalProjectRoot: directory,
            uprojectPath,
            projectIdentity,
            unrealOnline: true,
            debuggerPort: 27099,
            cachePath,
            cacheAccess: 'read-write',
            budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
        });
        assert.equal(loaded.loaded, true);
        let oldRevision = loaded.revision!;
        assert.equal(runtime.readiness.snapshot().generation, 0);
        runtime.beginLiveRefresh();
        runtime.cache.recordDebugDatabaseChunk({ UInvalidStartupReplacement: { properties: { Broken: null }, methods: {} } });
        let failure: unknown;
        try { runtime.cache.acceptCompleteCandidate(); } catch (error) { failure = error; }
        runtime.markHydrationFailed(failure);
        assert.equal(runtime.readiness.snapshot().generation, runtime.cache.getGeneration());
        assert.equal(runtime.readiness.snapshot().stage, 'parsing');
        assert.equal(runtime.readiness.snapshot().activeRevision, oldRevision);
        runtime.markCurrentGenerationFullReady();
        assert.equal(runtime.readiness.snapshot().fullReady, true);
        assert.equal(runtime.readiness.snapshot().activeRevision, oldRevision);
    }
    finally
    {
        runtime.shutdown();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('TypeDB refresh replaces the whole generation and reparses script-owned types', () => {
    ResetDatabaseForTests();
    let oldNative = new DBType().initEmpty('UOldGenerationOnly');
    AddTypeToDatabase(GetRootNamespace(), oldNative);
    let module = scriptfiles.GetOrCreateModule(
        'GenerationFixture',
        path.join(os.tmpdir(), 'GenerationFixture.as'),
        'file:///GenerationFixture.as',
    );
    scriptfiles.UpdateModuleFromContent(module, 'class UGenerationScriptType {}\n');
    scriptfiles.ParseModule(module);
    assert.ok(GetTypeByName('UOldGenerationOnly'));
    assert.ok(GetTypeByName('UGenerationScriptType'));

    let reset = resetTypeDatabaseForGeneration();
    assert.ok(reset.reparsedModuleCount >= 1);
    assert.equal(GetTypeByName('UOldGenerationOnly') == null, true);
    assert.ok(GetTypeByName('UGenerationScriptType'));
});
