import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
    normalizeDebugDatabaseAccessChunk,
    normalizeFunctionAccess,
    normalizePropertyAccess,
} from '../accessContract';
import * as parser from '../as_parser';
import * as database from '../database';
import { hydrateTypeDatabaseGeneration } from '../typeDatabaseGeneration';
import { createUnrealCacheController } from '../unrealCacheController';

function sidecarChunk() : Record<string, unknown>
{
    return {
        properties: [{
            owner: 'AActor',
            name: 'InitialLifeSpan',
            access: {
                read: { normal: 'allow', restricted: 'allow', restrictions: [{ code: 'Editable' }] },
                write: { normal: 'deny', restricted: 'allow', restrictions: [{ code: 'Editable' }] },
            },
        }],
        methods: [{
            owner: 'AActor',
            name: 'ReceiveActorBeginOverlap',
            args: [],
            access: { call: { state: 'deny' } },
        }],
    };
}

test('access sidecar normalizes direction states and callable restrictions', () =>
{
    let chunk = normalizeDebugDatabaseAccessChunk(sidecarChunk());
    assert.deepEqual(normalizePropertyAccess(chunk.properties![0].access), {
        read: { normal: 'allowed', restricted: 'allowed', restrictions: [{ code: 'Editable' }] },
        write: { normal: 'denied', restricted: 'allowed', restrictions: [{ code: 'Editable' }] },
    });
    assert.deepEqual(normalizeFunctionAccess(chunk.methods![0].access), {
        call: { state: 'denied' },
    });
});

test('access sidecar keeps capability metadata out of the payload and validates identities', () =>
{
    let invalid = { ...sidecarChunk(), __meta: { schema: 'wrong', version: 1, capabilities: [] as string[] } };
    assert.throws(() => normalizeDebugDatabaseAccessChunk(invalid), /Settings/i);
    assert.throws(() => normalizeDebugDatabaseAccessChunk({ properties: [{ name: 'MissingOwner', access: {} }] }), /identity/i);
});

test('custom access normalization rejects malformed states and unknown restriction codes', () =>
{
    assert.throws(() => normalizeDebugDatabaseAccessChunk({
        properties: [{
            owner: 'AActor',
            name: 'Broken',
            access: { read: { normal: 'maybe', restricted: 'allow' }, write: { normal: 'allow', restricted: 'allow' } },
        }],
    }), /access is invalid/i);
    assert.throws(() => normalizeDebugDatabaseAccessChunk({
        methods: [{
            owner: 'AActor',
            name: 'Broken',
            args: [],
            access: { call: { state: 'unknown' } },
        }],
    }), /access is invalid/i);
    assert.throws(() => normalizeDebugDatabaseAccessChunk({
        methods: [{
            owner: 'AActor',
            name: 'Broken',
            args: [],
            access: { call: { state: 'allow', restrictions: [{ code: 'Unknown' }] } },
        }],
    }), /restriction code/i);
    assert.throws(() => normalizeDebugDatabaseAccessChunk({
        properties: [{
            owner: 'AActor',
            name: 'BrokenDirection',
            access: {
                read: { normal: 'deny', restricted: 'allow' },
                write: { normal: 'allow', restricted: 'allow' },
            },
        }],
    }), /access is invalid/i);
});

test('legacy native records stay unchanged and sidecar access joins by owner and signature', () =>
{
    database.ResetDatabaseForTests();
    hydrateTypeDatabaseGeneration([{
        AActor: {
            properties: { InitialLifeSpan: ['float'] },
            methods: [{ name: 'Tick', return: 'void', args: [{ type: 'float', name: 'DeltaSeconds' }] }],
        },
    }], false, [normalizeDebugDatabaseAccessChunk({
        properties: [{
            owner: 'AActor',
            name: 'InitialLifeSpan',
            access: {
                read: { normal: 'allow', restricted: 'allow', restrictions: [{ code: 'Editable' }] },
                write: { normal: 'deny', restricted: 'allow', restrictions: [{ code: 'Editable' }] },
            },
        }],
        methods: [{
            owner: 'AActor',
            kind: 'method',
            name: 'Tick',
            args: [{ type: 'float', name: 'DeltaSeconds' }],
            return: 'void',
            access: { call: { state: 'allow', restrictions: [{ code: 'UnsafeDuringActorConstruction' }] } },
        }],
    })]);
    let type = database.GetTypeByName('AActor');
    assert.ok(type);
    assert.equal(type.getProperty('InitialLifeSpan', false)?.access?.write.normal, 'denied');
    assert.deepEqual(type.getMethod('Tick', false)?.access?.call.restrictions, [{ code: 'UnsafeDuringActorConstruction' }]);
});

test('sidecar merge preserves qualified overload identity', () =>
{
    database.ResetDatabaseForTests();
    hydrateTypeDatabaseGeneration([{
        FOverloads: {
            properties: {},
            methods: [
                { name: 'Op', return: 'int16&', args: [{ type: 'int16&', name: 'Value' }] },
                { name: 'Op', return: 'const int16&in', args: [{ type: 'const int16&in', name: 'Value' }], const: true },
            ],
        },
    }], false, [normalizeDebugDatabaseAccessChunk({
        methods: [
            {
                owner: 'FOverloads',
                kind: 'method',
                name: 'Op',
                signature: 'int16& Op(int16&)',
                args: [{ type: 'int16&', name: 'Value' }],
                return: 'int16&',
                access: { call: { state: 'allow' } },
            },
            {
                owner: 'FOverloads',
                kind: 'method',
                name: 'Op',
                signature: 'const int16&in Op(const int16&in) const',
                args: [{ type: 'const int16&in', name: 'Value' }],
                return: 'const int16&in',
                access: { call: { state: 'deny' } },
            },
        ],
    })]);
    let type = database.GetTypeByName('FOverloads');
    assert.ok(type);
    let overloads = type!.findSymbols('Op').filter((symbol): symbol is database.DBMethod => symbol instanceof database.DBMethod);
    assert.equal(overloads.length, 2);
    let mutable = overloads.find((method) => method.args[0].typename == 'int16&');
    let readonly = overloads.find((method) => method.args[0].typename == 'const int16&in');
    assert.equal(mutable?.access?.call.state, 'allowed');
    assert.equal(readonly?.access?.call.state, 'denied');
});

test('constructor access joins even when legacy return spelling differs', () =>
{
    database.ResetDatabaseForTests();
    hydrateTypeDatabaseGeneration([{
        AActor: {
            properties: {},
            methods: [{ name: 'AActor', isConstructor: true, return: 'void', args: [{ type: 'int', name: 'Value' }] }],
        },
    }], false, [normalizeDebugDatabaseAccessChunk({
        methods: [{
            owner: 'AActor',
            kind: 'constructor',
            name: 'AActor',
            return: 'AActor',
            signature: 'AActor(int)',
            args: [{ type: 'int', name: 'Value' }],
            access: { call: { state: 'allow' } },
        }],
    })]);
    let constructor = database.GetTypeByName('AActor')?.getMethod('AActor', false);
    assert.equal(constructor?.isConstructor, true);
    assert.equal(constructor?.access?.call.state, 'allowed');
});

test('constructor access joins legacy root-namespace constructor records', () =>
{
    database.ResetDatabaseForTests();
    let rootConstructor = new database.DBMethod();
    rootConstructor.name = 'AActor';
    rootConstructor.returnType = 'AActor';
    rootConstructor.args = [];
    rootConstructor.isConstructor = true;
    rootConstructor.declaredModule = null;
    database.GetRootNamespace().addSymbol(rootConstructor);
    database.ApplyDebugDatabaseAccess([normalizeDebugDatabaseAccessChunk({
        methods: [{
            owner: 'AActor',
            kind: 'constructor',
            name: 'AActor',
            return: 'AActor',
            args: [],
            access: { call: { state: 'allow' } },
        }],
    })]);
    assert.equal(rootConstructor.access?.call.state, 'allowed');
});

test('incomplete sidecar access is discarded before legacy fallback commit', () =>
{
    database.ResetDatabaseForTests();
    let controller = createUnrealCacheController({ publisherRetryDelaysMs: [] });
    controller.beginRefresh();
    controller.setDebugDatabaseAccessExpected(true);
    controller.recordDebugDatabaseChunk({
        AActor: { properties: { InitialLifeSpan: ['float'] }, methods: {} },
    });
    controller.recordDebugDatabaseAccessChunk({
        properties: [{
            owner: 'AActor',
            name: 'InitialLifeSpan',
            access: {
                read: { normal: 'allow', restricted: 'allow' },
                write: { normal: 'allow', restricted: 'allow' },
            },
        }],
    });
    controller.discardDebugDatabaseAccessChunks();
    controller.acceptCompleteCandidate();
    let property = database.GetTypeByName('AActor')?.getProperty('InitialLifeSpan', false);
    assert.equal(property?.access?.read.normal, 'unknown');
    assert.equal(property?.access?.write.normal, 'unknown');
});

test('accepted complete access remains ready after the live refresh closes', () =>
{
    database.ResetDatabaseForTests();
    let controller = createUnrealCacheController({ publisherRetryDelaysMs: [] });
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk({ AActor: { properties: {}, methods: {} } });
    controller.setDebugDatabaseAccessExpected(true);
    controller.recordDebugDatabaseAccessChunk({
        properties: [{
            owner: 'AActor',
            name: 'Value',
            access: {
                read: { normal: 'allow', restricted: 'allow' },
                write: { normal: 'allow', restricted: 'allow' },
            },
        }],
    });
    controller.finishDebugDatabaseAccess();
    controller.acceptCompleteCandidate();
    assert.equal(controller.getDebugDatabaseAccessReadiness(), 'complete');
});

test('an empty access stream cannot be marked complete', () =>
{
    database.ResetDatabaseForTests();
    let controller = createUnrealCacheController({ publisherRetryDelaysMs: [] });
    controller.beginRefresh();
    controller.recordDebugDatabaseChunk({ AActor: { properties: {}, methods: {} } });
    controller.setDebugDatabaseAccessExpected(true);
    controller.recordDebugDatabaseAccessChunk({ properties: [], methods: [] });
    controller.finishDebugDatabaseAccess();
    assert.equal(controller.getDebugDatabaseAccessReadiness(), 'failed');
    controller.acceptCompleteCandidate();
    assert.equal(controller.getDebugDatabaseAccessReadiness(), 'base-only');
});

test('watched script symbols expose AS access semantics', () =>
{
    database.ResetDatabaseForTests();
    parser.ClearAllResolvedModules();
    database.AddPrimitiveTypes(false);
    let moduleName = `Access.Contract.${Date.now()}`;
    let filePath = path.join(os.tmpdir(), `${moduleName}.as`);
    let module = parser.GetOrCreateModule(moduleName, filePath, pathToFileURL(filePath).toString());
    parser.UpdateModuleFromContent(module, `class UAccessFixture : UObject
{
    UPROPERTY(BlueprintReadOnly) int BlueprintReadOnlyValue;
    const int ConstValue;
    public int ExplicitPublic;
    void DefaultsOnlyFunction() defaults {}
    access Caller = *;
    access:Caller void CustomAccessFunction() {}
/*
#if EDITOR
    void CommentedEditorFunction() {}
#endif
*/
#if EDITOR
    void EditorOnlyFunction() {}
    #if OTHER_CONDITION
    void NestedEditorOnlyFunction() {}
    #endif
#endif
#if EDITOR // trailing comments do not change the condition
    void EditorOnlyWithTrailingComment() {}
#endif
#if !EDITOR
    void RuntimeFromNegatedEditor() {}
#else
    void EditorFromNegatedEditor() {}
#endif
#if OTHER_CONDITION
    void UnknownFromElifNegated() {}
#elif !EDITOR
    void RuntimeFromElifNegated() {}
#else
    void EditorFromElifNegated() {}
#endif
}`);
    parser.LoadAndParseModule(module);
    parser.PostProcessModuleTypes(module);
    parser.ResolveModule(module);

    let type = database.GetTypeByName('UAccessFixture');
    assert.ok(type);
    let normal = type.getProperty('BlueprintReadOnlyValue', false);
    let constant = type.getProperty('ConstValue', false);
    let explicitPublic = type.getProperty('ExplicitPublic', false);
    let defaults = type.getMethod('DefaultsOnlyFunction', false);
    let custom = type.getMethod('CustomAccessFunction', false);
    let editor = type.getMethod('EditorOnlyFunction', false);
    let nested = type.getMethod('NestedEditorOnlyFunction', false);
    let trailing = type.getMethod('EditorOnlyWithTrailingComment', false);
    let runtime = type.getMethod('RuntimeFromNegatedEditor', false);
    let negatedEditor = type.getMethod('EditorFromNegatedEditor', false);
    let runtimeElif = type.getMethod('RuntimeFromElifNegated', false);
    let editorElif = type.getMethod('EditorFromElifNegated', false);
    assert.ok(custom);
    assert.ok(editor);
    assert.ok(nested);
    assert.ok(trailing);
    assert.ok(runtime);
    assert.ok(negatedEditor);
    assert.ok(runtimeElif);
    assert.ok(editorElif);
    assert.deepEqual(normal?.access, {
        read: { normal: 'allowed', restricted: 'allowed' },
        write: { normal: 'allowed', restricted: 'allowed' },
    });
    assert.equal(constant?.access?.read.normal, 'allowed');
    assert.equal(constant?.access?.write.normal, 'denied');
    assert.equal(constant?.access?.write.restricted, 'allowed');
    assert.deepEqual(explicitPublic?.access, {
        read: { normal: 'allowed', restricted: 'allowed' },
        write: { normal: 'allowed', restricted: 'allowed' },
    });
    assert.deepEqual(defaults?.access?.call.restrictions, [{ code: 'DefaultsOnly' }]);
    assert.deepEqual(custom?.access?.call.restrictions, [{ code: 'CustomAccess' }]);
    assert.deepEqual(editor?.access?.call.restrictions, [{ code: 'EditorOnly' }]);
    assert.deepEqual(nested?.access?.call.restrictions, [{ code: 'EditorOnly' }]);
    assert.deepEqual(trailing?.access?.call.restrictions, [{ code: 'EditorOnly' }]);
    assert.deepEqual(runtime?.access?.call.restrictions, undefined);
    assert.deepEqual(negatedEditor?.access?.call.restrictions, [{ code: 'EditorOnly' }]);
    assert.deepEqual(runtimeElif?.access?.call.restrictions, undefined);
    assert.deepEqual(editorElif?.access?.call.restrictions, [{ code: 'EditorOnly' }]);
    assert.equal(type.getMethod('CommentedEditorFunction', false)?.access?.call.restrictions, undefined);
});
