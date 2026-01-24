import { LanguageClient } from 'vscode-languageclient/node';
import {
    AngelscriptSearchParams,
    ApiErrorPayload,
    ApiResponsePayload,
    SearchSource,
    buildSearchPayload,
    toApiErrorPayload
} from './angelscriptApiSearch';
import {
    GetTypeMembersParams,
    GetTypeMembersRequest,
    GetTypeMembersResult,
    ResolveSymbolAtPositionParams,
    ResolveSymbolAtPositionRequest,
    ResolveSymbolAtPositionResult
} from './apiRequests';

export type ToolErrorPayload = ApiErrorPayload;
export type SearchOutputPayload = ApiResponsePayload & {
    text?: string;
    request?: Record<string, unknown>;
};

export function isErrorPayload(value: unknown): value is ApiErrorPayload
{
    if (!value || typeof value !== 'object')
        return false;
    const maybe = value as { ok?: unknown; error?: { code?: unknown } };
    return maybe.ok === false && typeof maybe.error?.code === 'string';
}

export function formatSearchPayloadForOutput(
    payload: ApiResponsePayload,
    input: Partial<AngelscriptSearchParams> | null | undefined
): SearchOutputPayload
{
    if (!payload.items || payload.items.length > 0)
        return payload;

    const labelQuery = typeof input?.labelQuery === 'string' ? input.labelQuery.trim() : payload.labelQuery;
    const searchIndex = Number.isFinite(Number(input?.searchIndex)) ? Number(input?.searchIndex) : payload.searchIndex;
    const maxBatchResults = typeof input?.maxBatchResults === 'number' ? input?.maxBatchResults : 200;
    const request: Record<string, unknown> = {
        labelQuery,
        searchIndex,
        maxBatchResults,
        kinds: input?.kinds,
        source: input?.source ?? 'both',
        labelQueryUseRegex: input?.labelQueryUseRegex === true
    };
    const signatureRegex = typeof input?.signatureRegex === 'string' ? input.signatureRegex.trim() : '';
    if (signatureRegex)
    {
        request.signatureRegex = signatureRegex;
    }
    return {
        ...payload,
        text: `No Angelscript API results for "${labelQuery}".`,
        request
    };
}

function makeError(code: string, message: string, details?: Record<string, unknown>): ApiErrorPayload
{
    return {
        ok: false,
        error: {
            code,
            message,
            details
        }
    };
}

export async function runSearchApi(
    client: LanguageClient,
    startedClient: Promise<void>,
    input: unknown,
    shouldCancel?: () => boolean
): Promise<ApiResponsePayload | ApiErrorPayload>
{
    const raw = input as Partial<AngelscriptSearchParams> | null | undefined;
    const labelQuery = typeof raw?.labelQuery === 'string' ? raw.labelQuery.trim() : '';
    if (!labelQuery)
    {
        return makeError('MISSING_LABEL_QUERY', 'Missing labelQuery. Please provide labelQuery.');
    }
    const searchIndex = Number(raw?.searchIndex);
    const maxBatchResults = typeof raw?.maxBatchResults === 'number' ? raw.maxBatchResults : undefined;
    const source = typeof raw?.source === 'string' ? raw.source : undefined;
    const kinds = Array.isArray(raw?.kinds) ? raw?.kinds : undefined;

    try
    {
        await startedClient;
        const payload = await buildSearchPayload(
            client,
            {
                labelQuery,
                searchIndex,
                maxBatchResults,
                includeDocs: raw?.includeDocs,
                kinds,
                source: source as SearchSource | undefined,
                labelQueryUseRegex: raw?.labelQueryUseRegex,
                signatureRegex: raw?.signatureRegex
            },
            shouldCancel ?? (() => false)
        );
        return payload;
    }
    catch (error)
    {
        const apiError = toApiErrorPayload(error);
        if (apiError)
            return apiError;
        console.error("angelscript_searchApi tool failed:", error);
        return makeError('INTERNAL_ERROR', 'The Angelscript API tool failed to run. Please ensure the language server is running and try again.');
    }
}

export async function runResolveSymbolAtPosition(
    client: LanguageClient,
    startedClient: Promise<void>,
    input: unknown
): Promise<ResolveSymbolAtPositionResult | ApiErrorPayload>
{
    const raw = input as ResolveSymbolAtPositionParams | null | undefined;
    const uri = raw?.uri;
    const position = raw?.position;
    const line = position?.line;
    const character = position?.character;

    if (typeof uri !== 'string' || typeof line !== 'number' || typeof character !== 'number')
    {
        return makeError('InvalidParams', 'Invalid params. Provide uri and position { line, character }.');
    }

    const includeDocumentation = raw?.includeDocumentation !== false;

    try
    {
        await startedClient;
        return await client.sendRequest(
            ResolveSymbolAtPositionRequest,
            {
                uri,
                position: { line, character },
                includeDocumentation
            }
        ) as ResolveSymbolAtPositionResult;
    }
    catch (error)
    {
        console.error("angelscript_resolveSymbolAtPosition tool failed:", error);
        return makeError('INTERNAL_ERROR', 'The resolveSymbolAtPosition tool failed to run. Please ensure the language server is running and try again.');
    }
}

export async function runGetTypeMembers(
    client: LanguageClient,
    startedClient: Promise<void>,
    input: unknown
): Promise<GetTypeMembersResult | ApiErrorPayload>
{
    const raw = input as GetTypeMembersParams | null | undefined;
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name)
    {
        return makeError('InvalidParams', "Invalid params. 'name' must be a non-empty string.");
    }

    const namespace = typeof raw?.namespace === 'string' ? raw.namespace.trim() : undefined;
    const includeInherited = raw?.includeInherited === true;
    const includeDocs = raw?.includeDocs === true;
    const kinds = typeof raw?.kinds === 'string' ? raw.kinds.trim() : undefined;

    try
    {
        await startedClient;
        return await client.sendRequest<GetTypeMembersResult>(
            GetTypeMembersRequest.method,
            {
                name,
                namespace,
                includeInherited,
                includeDocs,
                kinds
            }
        ) as GetTypeMembersResult;
    }
    catch (error)
    {
        console.error("angelscript_getTypeMembers tool failed:", error);
        return makeError('INTERNAL_ERROR', 'The angelscript_getTypeMembers tool failed to run. Please ensure the language server is running and try again.');
    }
}
