import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChildProcess, fork, spawn } from 'node:child_process';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { loadDebugDatabaseCacheV2, saveDebugDatabaseCacheV2 } from '../debugDatabaseCacheV2';
import { DEFAULT_LANGUAGE_SERVER_BUDGETS } from '../languageServerContract';
import { computeScriptSnapshotPayloadHash } from '../scriptSnapshotProtocol';

type JsonRpcMessage = {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
};

type TestClient = {
    child: ChildProcess;
    notifications: JsonRpcMessage[];
    send: (message: JsonRpcMessage) => void;
    request: (method: string, params?: unknown) => Promise<JsonRpcMessage>;
    close: () => Promise<void>;
};

function createProject(content = 'class transport_fixture { int Bad_name; }\n', additionalFileCount = 0) : string
{
    let root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-ls-transport-'));
    fs.mkdirSync(path.join(root, 'Script'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Transport.uproject'), '{}');
    fs.writeFileSync(path.join(root, 'Script', 'TransportFixture.as'), content);
    for (let index = 0; index < additionalFileCount; ++index)
        fs.writeFileSync(path.join(root, 'Script', `TransportFixture${index}.as`), `class UTransportFixture${index} {}\n`);
    return root;
}

async function removeDirectoryEventually(directory: string) : Promise<void>
{
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; ++attempt)
    {
        try
        {
            fs.rmSync(directory, { recursive: true, force: true });
            return;
        }
        catch (error)
        {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError;
}

function assertSuccessfulChildExit(
    child: ChildProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
) : void
{
    if (exitCode === 0 && signal == null)
        return;
    throw new Error(
        `Child process ${child.pid ?? 'unknown'} exited unsuccessfully: code=${exitCode ?? 'null'}, signal=${signal ?? 'null'}, stderr=${stderr.trim() || '<empty>'}.`,
    );
}

async function waitForSuccessfulChildExit(child: ChildProcess, timeoutMs = 3000) : Promise<void>
{
    let stderr = '';
    let buffered: Buffer | string | null | undefined;
    while ((buffered = child.stderr?.read()) != null)
        stderr += buffered.toString();
    if (child.exitCode != null || child.signalCode != null)
    {
        assertSuccessfulChildExit(child, child.exitCode, child.signalCode, stderr);
        return;
    }
    await new Promise<void>((resolve, reject) => {
        let onStderr = (data: Buffer | string) => { stderr += data.toString(); };
        let onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            try
            {
                assertSuccessfulChildExit(child, exitCode, signal, stderr);
                resolve();
            }
            catch (error)
            {
                reject(error);
            }
        };
        let onError = (error: Error) => {
            cleanup();
            reject(new Error(`Child process ${child.pid ?? 'unknown'} failed: ${error.message}; stderr=${stderr.trim() || '<empty>'}.`));
        };
        let timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Child process ${child.pid ?? 'unknown'} did not exit within ${timeoutMs}ms; stderr=${stderr.trim() || '<empty>'}.`));
        }, timeoutMs);
        function cleanup() : void
        {
            clearTimeout(timer);
            child.stderr?.off('data', onStderr);
            child.off('exit', onExit);
            child.off('error', onError);
        }
        child.stderr?.on('data', onStderr);
        child.once('exit', onExit);
        child.once('error', onError);
    });
}

test('successful child exit helper rejects nonzero and signaled exits with stderr evidence', async () => {
    let nonzero = spawn(process.execPath, ['-e', "process.stderr.write('nonzero evidence');process.exit(7)"], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    await assert.rejects(
        waitForSuccessfulChildExit(nonzero),
        /code=7, signal=null, stderr=nonzero evidence/u,
    );

    let signaled = spawn(process.execPath, ['-e', "process.stderr.write('signal evidence');setInterval(() => {}, 1000)"], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    let stderrReady = new Promise<void>((resolve, reject) => {
        signaled.stderr!.once('data', () => resolve());
        signaled.once('error', reject);
    });
    let signalExit = waitForSuccessfulChildExit(signaled);
    await stderrReady;
    signaled.kill('SIGTERM');
    await assert.rejects(
        signalExit,
        /code=null, signal=SIGTERM, stderr=signal evidence/u,
    );
});

function projectIdentity(root: string) : string
{
    let uprojectPath = path.join(root, 'Transport.uproject');
    return process.platform == 'win32' ? uprojectPath.toLowerCase() : uprojectPath;
}

function writeEmptyNativeCache(root: string, projectIdentity: string) : string
{
    let cachePath = path.join(root, 'Script', '.vscode', 'angelscript', 'debug-database.v2.json.gz');
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
        debugDatabaseChunks: [{}],
    });
    return cachePath;
}

function createClient(transport: 'stdio' | 'ipc') : TestClient
{
    let server = path.resolve('language-server', 'dist', 'server.js');
    let child = transport == 'stdio'
        ? spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        : fork(server, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let nextId = 1;
    let pending = new Map<number, (message: JsonRpcMessage) => void>();
    let notifications: JsonRpcMessage[] = [];
    let accept = (message: JsonRpcMessage) => {
        if (typeof message.id == 'number' && pending.has(message.id))
        {
            pending.get(message.id)!(message);
            pending.delete(message.id);
        }
        else
        {
            notifications.push(message);
        }
    };
    if (transport == 'stdio')
    {
        let buffer = Buffer.alloc(0);
        child.stdout!.on('data', (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
            while (true)
            {
                let headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd < 0)
                    break;
                let header = buffer.subarray(0, headerEnd).toString('ascii');
                let length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
                if (!Number.isSafeInteger(length) || buffer.length < headerEnd + 4 + length)
                    break;
                let body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
                buffer = buffer.subarray(headerEnd + 4 + length);
                accept(JSON.parse(body.toString('utf8')));
            }
        });
    }
    else
    {
        child.on('message', (message) => accept(message as JsonRpcMessage));
    }
    function send(message: JsonRpcMessage) : void
    {
        if (transport == 'stdio')
        {
            let body = Buffer.from(JSON.stringify(message), 'utf8');
            child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
            child.stdin!.write(body);
        }
        else
        {
            child.send!(message);
        }
    }
    function request(method: string, params: unknown = {}) : Promise<JsonRpcMessage>
    {
        let id = nextId++;
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Timed out waiting for ${method}.`));
            }, 8000);
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            send({ jsonrpc: '2.0', id, method, params });
        });
    }
    async function close() : Promise<void>
    {
        if (child.exitCode == null)
        {
            try { await request('shutdown'); } catch {}
            send({ jsonrpc: '2.0', method: 'exit' });
        }
        await new Promise<void>((resolve) => {
            if (child.exitCode != null)
                return resolve();
            let timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    return { child, notifications, send, request, close };
}

for (let transport of ['stdio', 'ipc'] as const)
{
    test(`Language Server ${transport} supports offline initialize, status, workspace diagnostics, and bounded shutdown`, async () => {
        let root = createProject();
        let client = createClient(transport);
        try
        {
            let initialize = await client.request('initialize', {
                processId: process.pid,
                rootUri: `file:///${root.replace(/\\/g, '/')}`,
                capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
                initializationOptions: {
                    role: 'vscode',
                    canonicalProjectRoot: root,
                    uprojectPath: path.join(root, 'Transport.uproject'),
                    projectIdentity: projectIdentity(root),
                    unreal: { online: false, debuggerPort: 27099 },
                    cache: { enabled: false },
                },
            });
            assert.equal(initialize.error, undefined);
            let capabilities = (initialize.result as { capabilities: Record<string, unknown> }).capabilities;
            assert.ok(capabilities.diagnosticProvider);
            client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            let status = await client.request('angelscript/diagnosticsStatus');
            assert.equal((status.result as { unrealOnline: boolean }).unrealOnline, false);
            let apiStart = Date.now();
            let apiEarly = await client.request('angelscript/queryAPI', { query: 'AActor' });
            assert.ok(apiEarly.error);
            assert.ok(Date.now() - apiStart < 1000, 'Terminal partial coverage must fail API queries without the readiness retry window.');
            let diagnosticItems: unknown[] = [];
            for (let attempt = 0; attempt < 40 && diagnosticItems.length == 0; attempt += 1)
            {
                let diagnostics = await client.request('workspace/diagnostic', { previousResultIds: [] });
                diagnosticItems = (diagnostics.result as { items: unknown[] }).items;
                if (diagnosticItems.length == 0)
                    await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.ok(diagnosticItems.length > 0, 'Expected parse-only diagnostics for the invalid naming fixture.');
            let firstWorkspaceItem = diagnosticItems[0] as { uri: string; kind: string; resultId: string };
            assert.equal(firstWorkspaceItem.kind, 'full');
            let documentFull = await client.request('textDocument/diagnostic', {
                textDocument: { uri: firstWorkspaceItem.uri },
            });
            assert.equal((documentFull.result as { kind: string }).kind, 'full');
            let documentResultId = (documentFull.result as { resultId: string }).resultId;
            let documentUnchanged = await client.request('textDocument/diagnostic', {
                textDocument: { uri: firstWorkspaceItem.uri },
                previousResultId: documentResultId,
            });
            assert.deepEqual(documentUnchanged.result, { kind: 'unchanged', resultId: documentResultId });
            let workspaceUnchanged = await client.request('workspace/diagnostic', {
                previousResultIds: [{ uri: firstWorkspaceItem.uri, value: firstWorkspaceItem.resultId }],
            });
            assert.equal(((workspaceUnchanged.result as { items: Array<{ kind: string }> }).items[0]).kind, 'unchanged');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
        assert.notEqual(client.child.exitCode, null);
    });
}

test('offline missing-cache startup does not settle before the initial parse queue drains', async () => {
    let root = createProject(undefined, 300);
    let client = createClient('stdio');
    try
    {
        let initialize = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: {},
            initializationOptions: {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath: path.join(root, 'Transport.uproject'),
                projectIdentity: projectIdentity(root),
                unreal: { online: false },
                cache: { enabled: true },
            },
        });
        assert.equal(initialize.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        let early = (await client.request('angelscript/diagnosticsStatus')).result as {
            stage: string;
            semanticGeneration: number;
            settledSemanticGeneration: number;
        };
        assert.equal(early.stage, 'partial');
        assert.ok(early.semanticGeneration > early.settledSemanticGeneration,
            'The initial parse queue must remain externally unsettled.');

        let settled = false;
        for (let attempt = 0; attempt < 200 && !settled; ++attempt)
        {
            let status = (await client.request('angelscript/diagnosticsStatus')).result as typeof early;
            settled = status.stage == 'partial'
                && status.semanticGeneration == status.settledSemanticGeneration;
            if (!settled)
                await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(settled, true);
    }
    finally
    {
        await client.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('cached stdio startup resolves loaded scripts before publishing full readiness', async () => {
    let root = createProject();
    let identity = projectIdentity(root);
    let cachePath = writeEmptyNativeCache(root, identity);
    let client = createClient('stdio');
    try
    {
        let initialize = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
            initializationOptions: {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath: path.join(root, 'Transport.uproject'),
                projectIdentity: identity,
                unreal: { online: false },
                cache: { enabled: true },
            },
        });
        assert.equal(initialize.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        let fullReady = false;
        for (let attempt = 0; attempt < 80 && !fullReady; attempt += 1)
        {
            let status = await client.request('angelscript/diagnosticsStatus');
            fullReady = (status.result as { fullReady: boolean }).fullReady;
            if (!fullReady)
                await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(fullReady, true, 'A valid cache must let the resolve queue drain before full readiness.');
    }
    finally
    {
        await client.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('stdio EOF terminates the language server without an LSP shutdown request', async () => {
    let root = createProject();
    let client = createClient('stdio');
    let initialized = await client.request('initialize', {
        processId: process.pid,
        rootUri: `file:///${root.replace(/\\/g, '/')}`,
        capabilities: {},
        initializationOptions: {
            role: 'vscode',
            canonicalProjectRoot: root,
            uprojectPath: path.join(root, 'Transport.uproject'),
            projectIdentity: projectIdentity(root),
            unreal: { online: false },
            cache: { enabled: false },
        },
    });
    assert.equal(initialized.error, undefined);
    let stderr = '';
    client.child.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf8'); });
    client.child.stdin!.end();
    let exitCode = await new Promise<number | null>((resolve, reject) => {
        let timer = setTimeout(() => reject(new Error('Language Server survived stdio EOF.')), 3000);
        client.child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, stderr);
    fs.rmSync(root, { recursive: true, force: true });
});

test('project daemon child exits when its initialize.processId parent dies', async () => {
    let root = createProject();
    let host = path.resolve('language-server', 'src', '__tests__', 'fixtures', 'projectDaemonParentHost.js');
    let server = path.resolve('language-server', 'dist', 'server.js');
    let parent = spawn(process.execPath, [host, server, root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let childPid = 0;
    try
    {
        childPid = await new Promise<number>((resolve, reject) => {
            let buffer = '';
            let timer = setTimeout(() => reject(new Error('Parent host did not initialize the Language Server.')), 5000);
            parent.stdout.on('data', (data: Buffer) => {
                buffer += data.toString('utf8');
                let lineEnd = buffer.indexOf('\n');
                if (lineEnd < 0)
                    return;
                clearTimeout(timer);
                resolve(Number(buffer.slice(0, lineEnd).trim()));
            });
        });
        assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
        parent.kill();
        let exited = false;
        for (let attempt = 0; attempt < 50 && !exited; ++attempt)
        {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try { process.kill(childPid, 0); }
            catch { exited = true; }
        }
        assert.equal(exited, true, 'Language Server must exit after its project-daemon parent dies.');
    }
    finally
    {
        if (parent.exitCode == null)
            parent.kill();
        if (childPid > 0)
        {
            try { process.kill(childPid); } catch {}
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('project-daemon transport accepts only canonical full snapshots and rejects full-manifest drift', async () => {
    let root = createProject();
    let client = createClient('stdio');
    try
    {
        let initialized = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: {},
            initializationOptions: {
                role: 'project-daemon',
                canonicalProjectRoot: root,
                uprojectPath: path.join(root, 'Transport.uproject'),
                projectIdentity: projectIdentity(root),
                unreal: { debuggerPort: 27099 },
            },
        });
        assert.equal(initialized.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        let scriptPath = path.join(root, 'Script', 'TransportFixture.as');
        let scriptUri = `file:///${scriptPath.replace(/\\/g, '/')}`;
        let uppercaseScriptPath = path.join(root, 'Script', 'UppercaseExtension.AS');
        fs.writeFileSync(uppercaseScriptPath, 'class uppercase_extension_fixture {}\n');
        let uppercaseScriptUri = `file:///${uppercaseScriptPath.replace(/\\/g, '/')}`;
        let manifest = [
            {
                uri: scriptUri,
                hash: createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex'),
            },
            {
                uri: uppercaseScriptUri,
                hash: createHash('sha256').update(fs.readFileSync(uppercaseScriptPath)).digest('hex'),
            },
        ];
        let firstPayload = {
            protocolVersion: 1,
            mode: 'full' as const,
            scriptSequence: 1,
            scriptRevision: 'a'.repeat(64),
            payloadHash: '0'.repeat(64),
            manifest,
        };
        firstPayload.payloadHash = computeScriptSnapshotPayloadHash(firstPayload);
        let accepted = await client.request('angelscript/synchronizeScriptSnapshot', firstPayload);
        assert.deepEqual(accepted.error, undefined);
        assert.deepEqual(accepted.result, {
            accepted: true,
            serverInstanceId: (accepted.result as any).serverInstanceId,
            scriptSequence: 1,
            scriptRevision: 'a'.repeat(64),
        });

        let driftPayload = {
            protocolVersion: 1,
            mode: 'full' as const,
            scriptSequence: 2,
            scriptRevision: 'b'.repeat(64),
            payloadHash: '0'.repeat(64),
            manifest: [] as Array<{ uri: string; hash: string }>,
        };
        driftPayload.payloadHash = computeScriptSnapshotPayloadHash(driftPayload);
        let drift = await client.request('angelscript/synchronizeScriptSnapshot', driftPayload);
        assert.ok((drift.error as { message?: string } | undefined)?.message?.includes('omitted managed script'), JSON.stringify(drift));
    }
    finally
    {
        await client.close();
        await removeDirectoryEventually(root);
    }
});

test('VS Code and project daemon reconnect to a new Editor PID and publish isolated v2 caches', {
    skip: process.platform != 'win32',
}, async () => {
    let root = createProject();
    let serverPath = path.resolve('language-server', 'dist', 'server.js');
    let fixture = path.resolve('language-server', 'src', '__tests__', 'fixtures', 'fakeUnrealEditorTcp.ps1');
    let fakeEditor = path.join(root, 'UnrealEditor-Test.exe');
    fs.copyFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', fakeEditor);
    let uprojectPath = path.join(root, 'Transport.uproject');
    let identity = projectIdentity(root);
    let port = await new Promise<number>((resolve, reject) => {
        let probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            let address = probe.address() as net.AddressInfo;
            probe.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
    let clients = [createClient('stdio'), createClient('stdio')];
    let fake: ChildProcess | null = null;
    let startFake = async (typeName: string) => {
        fake = spawn(fakeEditor, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, uprojectPath, String(port), typeName], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        await new Promise<void>((resolve, reject) => {
            let output = '';
            let timer = setTimeout(() => reject(new Error('Fake Unreal Editor did not listen.')), 5000);
            fake!.stdout!.on('data', (data: Buffer) => {
                output += data.toString('utf8');
                if (output.includes('READY'))
                {
                    clearTimeout(timer);
                    resolve();
                }
            });
            fake!.once('error', reject);
        });
        return fake;
    };
    let cachePaths = [
        path.join(root, 'Script', '.vscode', 'angelscript', 'debug-database.v2.json.gz'),
        path.join(root, 'Saved', 'ASEditorAutomation', 'LanguageServer', 'debug-database.v2.json.gz'),
    ];
    let waitForType = async (typeName: string, priorRevisions: string[] = []) => {
        for (let attempt = 0; attempt < 160; ++attempt)
        {
            let loaded = cachePaths.map((cachePath) => loadDebugDatabaseCacheV2({
                cachePath,
                access: 'read-write',
                projectIdentity: identity,
                budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
            }));
            if (loaded.every((value, index) => value.ok
                && value.cache.revision != priorRevisions[index]
                && JSON.stringify(value.cache.debugDatabaseChunks).includes(typeName)))
                return loaded.map((value) => value.ok ? value.cache.revision : '');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        let logs = clients.flatMap((client) => client.notifications)
            .filter((message) => message.method == 'window/logMessage' || message.method == 'angelscript/diagnosticsStatus');
        throw new Error(`Timed out waiting for both role caches to publish ${typeName}: ${JSON.stringify(logs.slice(-20))}`);
    };
    try
    {
        let firstFake = await startFake('UFirstEditorGeneration');
        let initializationOptions = [
            {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath,
                projectIdentity: identity,
                unreal: { online: true, debuggerPort: port },
            },
            {
                role: 'project-daemon',
                canonicalProjectRoot: root,
                uprojectPath,
                projectIdentity: identity,
                unreal: { debuggerPort: port },
            },
        ];
        await Promise.all(clients.map(async (client, index) => {
            let initialized = await client.request('initialize', {
                processId: process.pid,
                rootUri: `file:///${root.replace(/\\/g, '/')}`,
                capabilities: {},
                initializationOptions: initializationOptions[index],
            });
            assert.equal(initialized.error, undefined);
            client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        }));
        let firstRevisions = await waitForType('UFirstEditorGeneration');
        let projectDaemonClient = clients[1];
        let projectDaemonStatus: {
            fullReady: boolean;
            semanticGeneration: number;
            settledSemanticGeneration: number;
        } | undefined;
        for (let attempt = 0; attempt < 100; ++attempt)
        {
            let status = await projectDaemonClient.request('angelscript/diagnosticsStatus');
            projectDaemonStatus = status.result as typeof projectDaemonStatus;
            if (projectDaemonStatus?.fullReady
                && projectDaemonStatus.semanticGeneration == projectDaemonStatus.settledSemanticGeneration)
                break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(projectDaemonStatus?.fullReady, true);
        assert.equal(projectDaemonStatus?.semanticGeneration, projectDaemonStatus?.settledSemanticGeneration);

        let scriptPath = path.join(root, 'Script', 'TransportFixture.as');
        let scriptUri = `file:///${scriptPath.replace(/\\/g, '/')}`;
        let snapshotPayload = {
            protocolVersion: 1,
            mode: 'full' as const,
            scriptSequence: 1,
            scriptRevision: 'd'.repeat(64),
            payloadHash: '0'.repeat(64),
            manifest: [{
                uri: scriptUri,
                hash: createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex'),
            }],
        };
        snapshotPayload.payloadHash = computeScriptSnapshotPayloadHash(snapshotPayload);
        let snapshot = await projectDaemonClient.request('angelscript/synchronizeScriptSnapshot', snapshotPayload);
        let snapshotResult = snapshot.result as {
            accepted: boolean;
            serverInstanceId: string;
            scriptSequence: number;
        };
        assert.equal(snapshot.error, undefined);
        assert.equal(snapshotResult.accepted, true);
        assert.equal(snapshotResult.scriptSequence, 1);

        let sequencedDiagnostics = await projectDaemonClient.request('angelscript/queryDiagnosticsAtScriptSequence', {
            protocolVersion: 1,
            expectedServerInstanceId: snapshotResult.serverInstanceId,
            minimumScriptSequence: 1,
        });
        assert.equal(sequencedDiagnostics.error, undefined);
        let diagnosticsReport = (sequencedDiagnostics.result as { result: {
            items: Array<{
                kind: string;
                uri: string;
                version: number | null;
                resultId: string;
                items: unknown[];
            }>;
        } }).result;
        let fullItem = diagnosticsReport.items.find((item) => item.uri.endsWith('/TransportFixture.as'));
        assert.ok(fullItem);
        assert.equal(fullItem?.kind, 'full');
        assert.equal(fullItem?.version, null);
        assert.equal(typeof fullItem?.resultId, 'string');
        assert.ok(Array.isArray(fullItem?.items));
        await waitForSuccessfulChildExit(firstFake);

        let secondFake = await startFake('USecondEditorGeneration');
        let secondRevisions = await waitForType('USecondEditorGeneration', firstRevisions);
        assert.notDeepEqual(secondRevisions, firstRevisions);
        await waitForSuccessfulChildExit(secondFake);
    }
    finally
    {
        await Promise.all(clients.map((client) => client.close()));
        if (fake?.exitCode == null)
        {
            fake.kill();
            await new Promise<void>((resolve) => fake!.once('exit', () => resolve()));
        }
        await removeDirectoryEventually(root);
    }
});

test('one verified socket accepts a delayed optional sidecar and consecutive native rounds', {
    skip: process.platform != 'win32',
    timeout: 20000,
}, async () => {
    let root = createProject('class URoundChild : URoundNative {}\n');
    let fixture = path.resolve('language-server', 'src', '__tests__', 'fixtures', 'fakeUnrealEditorRounds.ps1');
    let fakeEditor = path.join(root, 'UnrealEditor-Rounds.exe');
    fs.copyFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', fakeEditor);
    let uprojectPath = path.join(root, 'Transport.uproject');
    let identity = projectIdentity(root);
    let port = await new Promise<number>((resolve, reject) => {
        let probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            let address = probe.address() as net.AddressInfo;
            probe.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
    let fake = spawn(fakeEditor, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, uprojectPath, String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let client = createClient('stdio');
    try
    {
        await new Promise<void>((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('Round fixture did not listen.')), 5000);
            fake.stdout!.on('data', (data: Buffer) => {
                if (data.toString('utf8').includes('READY'))
                {
                    clearTimeout(timer);
                    resolve();
                }
            });
            fake.once('error', reject);
        });
        let initialized = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: {},
            initializationOptions: {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath,
                projectIdentity: identity,
                unreal: { online: true, debuggerPort: port },
            },
        });
        assert.equal(initialized.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        let waitForSettledRevision = async (prior?: string) => {
            for (let attempt = 0; attempt < 300; ++attempt)
            {
                let response = await client.request('angelscript/diagnosticsStatus');
                let status = response.result as {
                    fullReady: boolean;
                    semanticGeneration: number;
                    settledSemanticGeneration: number;
                    activeRevision?: string;
                    persistedRevision?: string;
                };
                if (status.fullReady
                    && status.semanticGeneration == status.settledSemanticGeneration
                    && status.activeRevision
                    && status.activeRevision == status.persistedRevision
                    && status.activeRevision != prior)
                    return status.activeRevision;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error('Timed out waiting for a settled native round.');
        };

        let firstRevision = await waitForSettledRevision();
        let firstDiagnostics = await client.request('workspace/diagnostic', { previousResultIds: [] });
        assert.doesNotMatch(JSON.stringify(firstDiagnostics.result), /URoundChild.*naming convention/i);
        let tokenRefreshesAfterFirst = client.notifications.filter((message) => message.method == 'workspace/semanticTokens/refresh').length;

        let secondRevision = await waitForSettledRevision(firstRevision);
        let secondDiagnostics = await client.request('workspace/diagnostic', { previousResultIds: [] });
        assert.match(JSON.stringify(secondDiagnostics.result), /URoundChild.*naming convention/i);
        let tokenRefreshesAfterSecond = client.notifications.filter((message) => message.method == 'workspace/semanticTokens/refresh').length;
        assert.equal(tokenRefreshesAfterSecond, tokenRefreshesAfterFirst + 1);
    }
    finally
    {
        await client.close();
        if (fake.exitCode == null)
        {
            fake.kill();
            await new Promise<void>((resolve) => fake.once('exit', () => resolve()));
        }
        await removeDirectoryEventually(root);
    }
});

test('same Editor PID recovers after a stale half-frame and an invalid finished generation', {
    skip: process.platform != 'win32',
    timeout: 30000,
}, async () => {
    let root = createProject();
    let fixture = path.resolve('language-server', 'src', '__tests__', 'fixtures', 'fakeUnrealEditorRecovery.ps1');
    let fakeEditor = path.join(root, 'UnrealEditor-Recovery.exe');
    fs.copyFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', fakeEditor);
    let uprojectPath = path.join(root, 'Transport.uproject');
    let identity = projectIdentity(root);
    let port = await new Promise<number>((resolve, reject) => {
        let probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            let address = probe.address() as net.AddressInfo;
            probe.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
    let fake = spawn(fakeEditor, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, uprojectPath, String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let client = createClient('stdio');
    try
    {
        await new Promise<void>((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('Recovery fixture did not listen.')), 5000);
            fake.stdout!.on('data', (data: Buffer) => {
                if (data.toString('utf8').includes('READY'))
                {
                    clearTimeout(timer);
                    resolve();
                }
            });
            fake.once('error', reject);
        });
        let initialized = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: {},
            initializationOptions: {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath,
                projectIdentity: identity,
                unreal: { online: true, debuggerPort: port },
            },
        });
        assert.equal(initialized.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        let recovered = false;
        for (let attempt = 0; attempt < 800 && !recovered; ++attempt)
        {
            let response = await client.request('angelscript/diagnosticsStatus');
            let status = response.result as {
                fullReady: boolean;
                activeRevision?: string;
                persistedRevision?: string;
            };
            let cache = loadDebugDatabaseCacheV2({
                cachePath: path.join(root, 'Script', '.vscode', 'angelscript', 'debug-database.v2.json.gz'),
                access: 'read-write',
                projectIdentity: identity,
                budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
            });
            recovered = status.fullReady
                && !!status.activeRevision
                && status.activeRevision == status.persistedRevision
                && cache.ok
                && JSON.stringify(cache.cache.debugDatabaseChunks).includes('URecoveredGeneration')
                && !JSON.stringify(cache.cache.debugDatabaseChunks).includes('UStalePartial');
            if (!recovered)
                await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(recovered, true, 'The verified same-PID reconnect sequence did not recover to the valid generation.');
    }
    finally
    {
        await client.close();
        if (fake.exitCode == null)
        {
            fake.kill();
            await new Promise<void>((resolve) => fake.once('exit', () => resolve()));
        }
        await removeDirectoryEventually(root);
    }
});

test('back-to-back A/B/C rounds settle and publish only generation C', {
    skip: process.platform != 'win32',
    timeout: 15000,
}, async () => {
    let root = createProject('class UBurstScriptType {}\n', 80);
    let fixture = path.resolve('language-server', 'src', '__tests__', 'fixtures', 'fakeUnrealEditorBurst.ps1');
    let fakeEditor = path.join(root, 'UnrealEditor-Burst.exe');
    fs.copyFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', fakeEditor);
    let uprojectPath = path.join(root, 'Transport.uproject');
    let identity = projectIdentity(root);
    let port = await new Promise<number>((resolve, reject) => {
        let probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            let address = probe.address() as net.AddressInfo;
            probe.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
    let fake = spawn(fakeEditor, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, uprojectPath, String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let client = createClient('stdio');
    try
    {
        await new Promise<void>((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('Burst fixture did not listen.')), 5000);
            fake.stdout!.on('data', (data: Buffer) => {
                if (data.toString('utf8').includes('READY'))
                {
                    clearTimeout(timer);
                    resolve();
                }
            });
            fake.once('error', reject);
        });
        let initialized = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: {},
            initializationOptions: {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath,
                projectIdentity: identity,
                unreal: { online: true, debuggerPort: port },
            },
        });
        assert.equal(initialized.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        let cachePath = path.join(root, 'Script', '.vscode', 'angelscript', 'debug-database.v2.json.gz');
        let settled = false;
        for (let attempt = 0; attempt < 300 && !settled; ++attempt)
        {
            let response = await client.request('angelscript/diagnosticsStatus');
            let status = response.result as {
                fullReady: boolean;
                semanticGeneration: number;
                settledSemanticGeneration: number;
                activeRevision?: string;
                persistedRevision?: string;
            };
            let cache = loadDebugDatabaseCacheV2({
                cachePath,
                access: 'read-write',
                projectIdentity: identity,
                budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
            });
            settled = status.fullReady
                && status.semanticGeneration == status.settledSemanticGeneration
                && !!status.activeRevision
                && status.activeRevision == status.persistedRevision
                && cache.ok
                && JSON.stringify(cache.cache.debugDatabaseChunks).includes('UBurstC');
            if (!settled)
                await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(settled, true);
        let cache = loadDebugDatabaseCacheV2({
            cachePath,
            access: 'read-write',
            projectIdentity: identity,
            budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
        });
        assert.equal(cache.ok, true);
        if (cache.ok)
        {
            let serialized = JSON.stringify(cache.cache.debugDatabaseChunks);
            assert.match(serialized, /UBurstC/);
            assert.doesNotMatch(serialized, /UBurstA|UBurstB/);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        let tokenRefreshes = client.notifications.filter((message) => message.method == 'workspace/semanticTokens/refresh').length;
        assert.equal(tokenRefreshes, 1);
    }
    finally
    {
        await client.close();
        if (fake.exitCode == null)
        {
            fake.kill();
            await new Promise<void>((resolve) => fake.once('exit', () => resolve()));
        }
        await removeDirectoryEventually(root);
    }
});

test('a failed replacement resumes diagnostics for the restored active generation', {
    skip: process.platform != 'win32',
    timeout: 15000,
}, async () => {
    let root = createProject('class URestoreScriptType {}\n', 80);
    let fixture = path.resolve('language-server', 'src', '__tests__', 'fixtures', 'fakeUnrealEditorRollback.ps1');
    let fakeEditor = path.join(root, 'UnrealEditor-Rollback.exe');
    fs.copyFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', fakeEditor);
    let uprojectPath = path.join(root, 'Transport.uproject');
    let identity = projectIdentity(root);
    let port = await new Promise<number>((resolve, reject) => {
        let probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            let address = probe.address() as net.AddressInfo;
            probe.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
    let fake = spawn(fakeEditor, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, uprojectPath, String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let client = createClient('stdio');
    try
    {
        await new Promise<void>((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('Rollback fixture did not listen.')), 5000);
            fake.stdout!.on('data', (data: Buffer) => {
                if (data.toString('utf8').includes('READY'))
                {
                    clearTimeout(timer);
                    resolve();
                }
            });
            fake.once('error', reject);
        });
        let initialized = await client.request('initialize', {
            processId: process.pid,
            rootUri: `file:///${root.replace(/\\/g, '/')}`,
            capabilities: {},
            initializationOptions: {
                role: 'vscode',
                canonicalProjectRoot: root,
                uprojectPath,
                projectIdentity: identity,
                unreal: { online: true, debuggerPort: port },
            },
        });
        assert.equal(initialized.error, undefined);
        client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        let cachePath = path.join(root, 'Script', '.vscode', 'angelscript', 'debug-database.v2.json.gz');
        let restored = false;
        let lastObserved: unknown;
        for (let attempt = 0; attempt < 300 && !restored; ++attempt)
        {
            let response = await client.request('angelscript/diagnosticsStatus');
            let status = response.result as {
                fullReady: boolean;
                semanticGeneration: number;
                settledSemanticGeneration: number;
                activeRevision?: string;
                persistedRevision?: string;
            };
            let cache = loadDebugDatabaseCacheV2({
                cachePath,
                access: 'read-write',
                projectIdentity: identity,
                budgets: DEFAULT_LANGUAGE_SERVER_BUDGETS,
            });
            restored = status.fullReady
                && status.semanticGeneration == status.settledSemanticGeneration
                && !!status.activeRevision
                && status.activeRevision == status.persistedRevision
                && cache.ok
                && JSON.stringify(cache.cache.debugDatabaseChunks).includes('URestoredActive');
            lastObserved = { status, cache };
            if (!restored)
                await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(restored, true, JSON.stringify(lastObserved));
    }
    finally
    {
        await client.close();
        if (fake.exitCode == null)
        {
            fake.kill();
            await new Promise<void>((resolve) => fake.once('exit', () => resolve()));
        }
        await removeDirectoryEventually(root);
    }
});
