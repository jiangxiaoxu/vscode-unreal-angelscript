import * as scriptfiles from './as_parser';
import * as typedb from './database';
import type { DebugDatabaseAccessChunk } from './accessContract';

export type TypeDatabaseGenerationReset = {
    reparsedModuleCount: number;
};

export function resetTypeDatabaseForGeneration() : TypeDatabaseGenerationReset
{
    let modules = scriptfiles.GetAllLoadedModules();
    let snapshots = modules.map((module) => ({ module, content: module.content }));
    typedb.ResetDatabaseForTests();
    for (let snapshot of snapshots)
    {
        scriptfiles.UpdateModuleFromContent(snapshot.module, snapshot.content);
        scriptfiles.ParseModule(snapshot.module);
    }
    return { reparsedModuleCount: snapshots.length };
}

export function postProcessScriptTypesForGeneration() : void
{
    for (let module of scriptfiles.GetAllParsedModules())
        scriptfiles.PostProcessModuleTypes(module);
}

export function resolveAllScriptModulesForGeneration() : void
{
    for (let module of scriptfiles.GetAllParsedModules())
        scriptfiles.ResolveModule(module);
}

export function validateDebugDatabaseChunks(chunks: readonly unknown[]) : void
{
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1)
    {
        let chunk = chunks[chunkIndex];
        if (!chunk || typeof chunk != 'object' || Array.isArray(chunk))
            throw new Error(`DebugDatabase chunk ${chunkIndex} must be an object.`);
        for (let [typeName, typeRecord] of Object.entries(chunk))
        {
            if (typeName.length == 0 || !typeRecord || typeof typeRecord != 'object' || Array.isArray(typeRecord))
                throw new Error(`DebugDatabase chunk ${chunkIndex} contains an invalid type record.`);
        }
    }
}

export function hydrateTypeDatabaseGeneration(
    chunks: readonly unknown[],
    floatIsFloat64: boolean,
    accessChunks: readonly DebugDatabaseAccessChunk[] = [],
) : void
{
    validateDebugDatabaseChunks(chunks);
    resetTypeDatabaseForGeneration();
    try
    {
        for (let chunk of chunks)
            typedb.AddTypesFromUnreal(chunk);
        typedb.ApplyDebugDatabaseAccess(accessChunks);
        typedb.FinishTypesFromUnreal();
        typedb.AddPrimitiveTypes(floatIsFloat64);
        postProcessScriptTypesForGeneration();
    }
    catch (error)
    {
        resetTypeDatabaseForGeneration();
        throw error;
    }
}
