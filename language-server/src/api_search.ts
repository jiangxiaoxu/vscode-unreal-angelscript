import * as typedb from './database';
import {
    unknownFunctionAccess,
    unknownPropertyAccess,
} from './accessContract';
import type { FunctionAccess, PropertyAccess } from './accessContract';

export type ApiSearchMode = 'smart' | 'regex';
export type ApiSearchSource = 'native' | 'script' | 'both';
export type ApiSearchMatchSource = 'native' | 'script';
export type ApiSearchKind = 'class' | 'struct' | 'enum' | 'method' | 'function' | 'property' | 'globalVariable';
export type ApiSearchScopeKind = 'namespace' | 'class' | 'struct' | 'enum';
export type ApiSearchScopeRelationship = 'declared' | 'inherited' | 'mixin';
export type ApiSearchSymbolLevel = 'all' | 'type';
export type ApiSearchMatchedBy = 'self' | 'member' | 'mixin';

export type GetAPISearchParams = {
    query: string;
    mode?: ApiSearchMode;
    limit?: number;
    offset?: number;
    kinds?: ApiSearchKind[];
    source?: ApiSearchSource;
    scope?: string;
    includeInheritedFromScope?: boolean;
    includeDocs?: boolean;
    symbolLevel?: ApiSearchSymbolLevel;
};

export type GetAPISearchNotice = {
    code: string;
    message: string;
};

export type ApiInheritedScopeOutcome =
    | 'applied'
    | 'ignored_missing_scope'
    | 'ignored_scope_not_found'
    | 'ignored_scope_not_class'
    | 'ignored_scope_ambiguous';

export type GetAPISearchScopeLookup = {
    requestedScope: string;
    resolvedQualifiedName?: string;
    resolvedKind?: ApiSearchScopeKind;
    ambiguousCandidates?: string[];
};

export type GetAPISearchResolvedScope = {
    requestedScope: string;
    resolvedQualifiedName: string;
    resolvedKind: ApiSearchScopeKind;
};

export type GetAPISearchMatch = {
    qualifiedName: string;
    kind: ApiSearchKind;
    signature: string;
    matchReason?: SearchMatchReason;
    summary?: string;
    documentation?: string;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    access?: PropertyAccess | FunctionAccess;
    isMixin?: boolean;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    scopeRelationship?: ApiSearchScopeRelationship;
    scopeDistance?: number;
    matchedBy?: ApiSearchMatchedBy;
    matchedByQualifiedName?: string;
    matchedByKind?: ApiSearchKind;
    detailsData?: unknown;
};

export type GetAPISearchMatchCounts = {
    total: number;
    returned: number;
    omitted: number;
};

export type GetAPISearchScopeGroup = {
    scope: GetAPISearchResolvedScope;
    matches: GetAPISearchMatch[];
    totalMatches: number;
    omittedMatches: number;
};

export type GetAPISearchResult = {
    matches: GetAPISearchMatch[];
    matchCounts: GetAPISearchMatchCounts;
    notices?: GetAPISearchNotice[];
    scopeLookup?: GetAPISearchScopeLookup;
    scopeGroups?: GetAPISearchScopeGroup[];
    inheritedScopeOutcome?: ApiInheritedScopeOutcome;
};

export class ApiSearchValidationError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'ApiSearchValidationError';
    }
}

export type SearchMatchReason =
    | 'exact-qualified'
    | 'exact-short'
    | 'boundary-ordered'
    | 'ordered-wildcard'
    | 'short-ordered';

type ScopeInheritanceMode = 'auto' | 'on' | 'off';
type ApiSearchTypeKind = Extract<ApiSearchKind, 'class' | 'struct' | 'enum'>;

type NormalizedSearchParams = {
    query: string;
    mode: ApiSearchMode;
    limit: number;
    offset: number;
    searchKinds: Set<ApiSearchKind>;
    source: ApiSearchSource;
    scope?: string;
    includeInheritedFromScopeMode: ScopeInheritanceMode;
    includeDocs: boolean;
    symbolLevel: ApiSearchSymbolLevel;
    typeResultKinds?: Set<ApiSearchTypeKind>;
    smartQueries?: ParsedSmartQuery[];
};

type ScopeCandidate = {
    kind: ApiSearchScopeKind;
    qualifiedName: string;
    shortName: string;
    namespace?: typedb.DBNamespace;
    dbType?: typedb.DBType;
    isClassType: boolean;
};

type SearchBoundaryKind = 'namespace' | 'member';

type SearchBoundary = {
    kind: SearchBoundaryKind;
    start: number;
    end: number;
};

type SearchTextVariant = {
    text: string;
    textLower: string;
    boundaries: SearchBoundary[];
};

type SearchIndexEntry = {
    qualifiedName: string;
    kind: ApiSearchKind;
    isCallable: boolean;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    signature: string;
    summary?: string;
    documentation?: string;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    access?: PropertyAccess | FunctionAccess;
    filterSource: ApiSearchSource;
    detailsData?: unknown;
    shortName: string;
    shortNameLower: string;
    qualifiedNameLower: string;
    shortText: SearchTextVariant;
    qualifiedText: SearchTextVariant;
    namespaceQualifiedName: string;
    declaringTypeQualifiedName?: string;
    isMixin: boolean;
    mixinTargetQualifiedName?: string;
    qualifiedAliasTexts: SearchTextVariant[];
    overrideKey?: string;
};

type SearchIndex = {
    entries: SearchIndexEntry[];
    scopeCandidates: ScopeCandidate[];
    typeEntriesByQualifiedName: Map<string, SearchIndexEntry>;
};

type SearchCandidate = {
    entry: SearchIndexEntry;
    scopeRelationship?: ApiSearchScopeRelationship;
    scopeDistance?: number;
    matchReason?: SearchMatchReason;
    matchSort?: SearchMatchSortKey;
    matchedBy?: ApiSearchMatchedBy;
    matchedByQualifiedName?: string;
    matchedByKind?: ApiSearchKind;
    projectedRank?: number;
};

type ResolvedScope = {
    kind: 'namespace';
    qualifiedName: string;
    namespace: typedb.DBNamespace;
    scopeLookup: GetAPISearchScopeLookup;
} | {
    kind: 'type';
    qualifiedName: string;
    dbType: typedb.DBType;
    scopeLookup: GetAPISearchScopeLookup;
    includeInherited: boolean;
};

type ScopeResolution = {
    scopes: ResolvedScope[];
    notices: GetAPISearchNotice[];
    scopeLookup: GetAPISearchScopeLookup;
    inheritedScopeOutcome?: ApiInheritedScopeOutcome;
    hasMergedSameNameScope?: boolean;
};

type ScopeCandidateMatchMode = 'exact-qualified' | 'exact-short' | 'prefix';

type RankedScopeGroup = {
    scope: ResolvedScope;
    candidates: SearchCandidate[];
};

type LimitedScopeGroup = {
    scope: ResolvedScope;
    candidates: SearchCandidate[];
    totalMatches: number;
    omittedMatches: number;
};

type SearchConnector = 'space' | 'namespace' | 'member';

type ParsedSmartQuery = {
    raw: string;
    rawLower: string;
    segments: string[];
    connectors: SearchConnector[];
    hasStrongSeparator: boolean;
    searchableCharCount: number;
    requiresCallable: boolean;
    requiresLeafTermination: boolean;
};

type SearchMatchSortKey = {
    reasonRank: number;
    qualifiedPriorityEnabled: number;
    exactQualifiedPriority: number;
    qualifiedStart: number;
    qualifiedTotalGap: number;
    qualifiedSpan: number;
    start: number;
    totalGap: number;
    span: number;
    viewPriority: number;
};

type SearchMatchOutcome = {
    reason: SearchMatchReason;
    sortKey: SearchMatchSortKey;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;
const DEFAULT_OFFSET = 0;
const QUERY_TOO_SHORT_THRESHOLD = 2;

const allKinds = new Set<ApiSearchKind>([
    'class',
    'struct',
    'enum',
    'method',
    'function',
    'property',
    'globalVariable'
]);
const typeOnlyKinds = new Set<ApiSearchTypeKind>([
    'class',
    'struct',
    'enum'
]);

const kindOrder: Record<ApiSearchKind, number> = {
    class: 0,
    struct: 1,
    enum: 2,
    method: 3,
    function: 4,
    property: 5,
    globalVariable: 6
};

const kindAliases: Record<string, ApiSearchKind> = {
    class: 'class',
    struct: 'struct',
    enum: 'enum',
    method: 'method',
    function: 'function',
    property: 'property',
    globalvariable: 'globalVariable'
};

let cachedSearchIndex: SearchIndex | null = null;
let cachedDirtyTypeCacheId = -1;

export function InvalidateAPISearchCache()
{
    cachedSearchIndex = null;
    cachedDirtyTypeCacheId = -1;
}

export function GetAPISearch(payload: unknown) : GetAPISearchResult
{
    let params = normalizeSearchParams(payload);
    let notices: GetAPISearchNotice[] = [];
    let scopeLookup: GetAPISearchScopeLookup | undefined = undefined;
    let inheritedScopeOutcome: ApiInheritedScopeOutcome | undefined = undefined;
    let scopeGroups: GetAPISearchScopeGroup[] | undefined = undefined;

    let index = getSearchIndex();
    let baseCandidates = index.entries.map((entry) : SearchCandidate => ({ entry }));
    let resolvedScopes: ResolvedScope[] = [];
    let hasMergedSameNameScope = false;

    if (params.includeInheritedFromScopeMode == 'on' && !params.scope)
        inheritedScopeOutcome = 'ignored_missing_scope';

    if (params.scope)
    {
        let scopeResolution = resolveScope(index, params.scope, params.includeInheritedFromScopeMode);
        notices.push(...scopeResolution.notices);
        scopeLookup = scopeResolution.scopeLookup;
        inheritedScopeOutcome = scopeResolution.inheritedScopeOutcome;
        resolvedScopes = scopeResolution.scopes;
        hasMergedSameNameScope = scopeResolution.hasMergedSameNameScope === true;
        if (resolvedScopes.length == 0)
        {
            return finalizeSearchResult([], notices, {
                scopeLookup,
                inheritedScopeOutcome,
                matchCounts: createMatchCounts(0, 0)
            });
        }
    }

    if (params.mode == 'smart' && params.smartQueries && params.smartQueries.every((query) => isTinySmartQuery(query)))
    {
        notices.push({
            code: 'QUERY_TOO_SHORT',
            message: `Smart search requires at least ${QUERY_TOO_SHORT_THRESHOLD} searchable characters.`
        });
        if (hasMergedSameNameScope)
            scopeGroups = buildScopeGroupsFromLimitedGroups([], resolvedScopes, params.includeDocs);

        return finalizeSearchResult([], notices, {
            scopeLookup,
            scopeGroups,
            inheritedScopeOutcome,
            matchCounts: createMatchCounts(0, 0)
        });
    }

    if (!hasMergedSameNameScope)
    {
        let candidates = baseCandidates;
        if (resolvedScopes.length == 1)
            candidates = applyResolvedScope(candidates, resolvedScopes[0], notices);

        candidates = candidates.filter((candidate) => filterCandidate(candidate.entry, params));
        let scoredMatches = rankAndProjectCandidates(candidates, params, index);
        let limitedMatches = scoredMatches
            .slice(params.offset, params.offset + params.limit)
            .map((candidate) => buildMatch(candidate, params.includeDocs));
        return finalizeSearchResult(limitedMatches, notices, {
            scopeLookup,
            inheritedScopeOutcome,
            matchCounts: createMatchCounts(scoredMatches.length, limitedMatches.length)
        });
    }

    let rankedScopeGroups = buildRankedScopeGroups(baseCandidates, resolvedScopes, notices, params, index);
    let limitedScopeGroups = limitMergedScopeGroups(rankedScopeGroups, params.offset, params.limit);
    scopeGroups = buildScopeGroupsFromLimitedGroups(limitedScopeGroups, resolvedScopes, params.includeDocs);
    let matches = scopeGroups.flatMap((group) => group.matches);
    let totalMatches = scopeGroups.reduce((sum, group) => sum + group.totalMatches, 0);
    return finalizeSearchResult(matches, notices, {
        scopeLookup,
        scopeGroups,
        inheritedScopeOutcome,
        matchCounts: createMatchCounts(totalMatches, matches.length)
    });
}

function normalizeSearchParams(payload: unknown) : NormalizedSearchParams
{
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new ApiSearchValidationError("Invalid params. Provide { query: string, mode?: 'smart' | 'regex', limit?: number, offset?: number, kinds?: ApiSearchKind[], source?: 'native' | 'script' | 'both', scope?: string, includeInheritedFromScope?: boolean, includeDocs?: boolean, symbolLevel?: 'all' | 'type' }.");

    let record = payload as Record<string, unknown>;
    let query = typeof record.query === 'string' ? record.query.trim() : '';
    if (query.length == 0)
        throw new ApiSearchValidationError("Invalid params. 'query' must be a non-empty string.");

    let mode = normalizeSearchMode(record.mode);
    let limit = normalizeLimit(record.limit);
    let offset = normalizeOffset(record.offset);
    let symbolLevel = normalizeSymbolLevel(record.symbolLevel);
    let kinds = normalizeKinds(record.kinds, symbolLevel);
    let source = normalizeSource(record.source);
    let scope = typeof record.scope === 'string' ? record.scope.trim() : '';
    let includeInheritedFromScopeMode = normalizeScopeInheritanceMode(record);
    let includeDocs = record.includeDocs === true;
    let smartQueries = mode == 'smart' ? parseSmartQueries(query) : undefined;

    return {
        query,
        mode,
        limit,
        offset,
        searchKinds: kinds.searchKinds,
        source,
        ...(scope.length > 0 ? { scope } : {}),
        includeInheritedFromScopeMode,
        includeDocs,
        symbolLevel,
        ...(kinds.typeResultKinds ? { typeResultKinds: kinds.typeResultKinds } : {}),
        ...(smartQueries ? { smartQueries } : {})
    };
}

function normalizeScopeInheritanceMode(record: Record<string, unknown>) : ScopeInheritanceMode
{
    if (!Object.prototype.hasOwnProperty.call(record, 'includeInheritedFromScope'))
        return 'auto';
    return record.includeInheritedFromScope === true ? 'on' : 'off';
}

function normalizeSearchMode(value: unknown) : ApiSearchMode
{
    if (value === undefined)
        return 'smart';
    if (typeof value !== 'string')
        throw new ApiSearchValidationError("Invalid params. 'mode' must be 'smart' or 'regex'.");

    let normalized = value.trim().toLowerCase();
    if (normalized == 'smart' || normalized == 'regex')
        return normalized as ApiSearchMode;

    throw new ApiSearchValidationError("Invalid params. 'mode' must be 'smart' or 'regex'.");
}

function normalizeSymbolLevel(value: unknown) : ApiSearchSymbolLevel
{
    if (value === undefined)
        return 'all';
    if (typeof value !== 'string')
        throw new ApiSearchValidationError("Invalid params. 'symbolLevel' must be 'all' or 'type'.");

    let normalized = value.trim().toLowerCase();
    if (normalized == 'all' || normalized == 'type')
        return normalized as ApiSearchSymbolLevel;

    throw new ApiSearchValidationError("Invalid params. 'symbolLevel' must be 'all' or 'type'.");
}

function normalizeLimit(value: unknown) : number
{
    if (value === undefined)
        return DEFAULT_LIMIT;
    if (typeof value !== 'number' || !Number.isInteger(value))
        throw new ApiSearchValidationError("Invalid params. 'limit' must be an integer.");
    if (value < 1 || value > MAX_LIMIT)
        throw new ApiSearchValidationError(`Invalid params. 'limit' must be between 1 and ${MAX_LIMIT}.`);
    return value;
}

function normalizeOffset(value: unknown) : number
{
    if (value === undefined)
        return DEFAULT_OFFSET;
    if (typeof value !== 'number' || !Number.isInteger(value))
        throw new ApiSearchValidationError("Invalid params. 'offset' must be an integer.");
    if (value < 0)
        throw new ApiSearchValidationError("Invalid params. 'offset' must be greater than or equal to 0.");
    return value;
}

function normalizeKinds(
    value: unknown,
    symbolLevel: ApiSearchSymbolLevel
) : { searchKinds: Set<ApiSearchKind>; typeResultKinds?: Set<ApiSearchTypeKind> }
{
    if (symbolLevel == 'type')
    {
        if (value === undefined)
        {
            return {
                searchKinds: new Set(allKinds),
                typeResultKinds: new Set(typeOnlyKinds)
            };
        }
        if (!Array.isArray(value))
            throw new ApiSearchValidationError("Invalid params. 'kinds' must be an array.");

        let typeKinds = new Set<ApiSearchTypeKind>();
        for (let item of value)
        {
            if (typeof item !== 'string')
                throw new ApiSearchValidationError("Invalid params. 'kinds' entries must be strings.");

            let normalized = item.trim().toLowerCase();
            let kind = kindAliases[normalized];
            if (!kind)
                throw new ApiSearchValidationError(`Invalid params. Unsupported kind "${item}".`);
            if (kind != 'class' && kind != 'struct' && kind != 'enum')
                throw new ApiSearchValidationError(`Invalid params. 'kinds' only supports class, struct, or enum when 'symbolLevel' is 'type'. Unsupported kind "${item}".`);
            typeKinds.add(kind as ApiSearchTypeKind);
        }

        return {
            searchKinds: new Set(allKinds),
            typeResultKinds: typeKinds.size == 0 ? new Set(typeOnlyKinds) : typeKinds
        };
    }

    if (value === undefined)
        return {
            searchKinds: new Set(allKinds)
        };
    if (!Array.isArray(value))
        throw new ApiSearchValidationError("Invalid params. 'kinds' must be an array.");

    let kinds = new Set<ApiSearchKind>();
    for (let item of value)
    {
        if (typeof item !== 'string')
            throw new ApiSearchValidationError("Invalid params. 'kinds' entries must be strings.");

        let normalized = item.trim().toLowerCase();
        let kind = kindAliases[normalized];
        if (!kind)
            throw new ApiSearchValidationError(`Invalid params. Unsupported kind "${item}".`);
        kinds.add(kind);
    }

    return {
        searchKinds: kinds.size == 0 ? new Set(allKinds) : kinds
    };
}

function normalizeSource(value: unknown) : ApiSearchSource
{
    if (value === undefined)
        return 'both';
    if (typeof value !== 'string')
        throw new ApiSearchValidationError("Invalid params. 'source' must be 'native', 'script', or 'both'.");

    let normalized = value.trim().toLowerCase();
    if (normalized == 'native' || normalized == 'script' || normalized == 'both')
        return normalized as ApiSearchSource;

    throw new ApiSearchValidationError("Invalid params. 'source' must be 'native', 'script', or 'both'.");
}

function finalizeSearchResult(
    matches: GetAPISearchMatch[],
    notices: GetAPISearchNotice[],
    options: {
        scopeLookup?: GetAPISearchScopeLookup;
        scopeGroups?: GetAPISearchScopeGroup[];
        inheritedScopeOutcome?: ApiInheritedScopeOutcome;
        matchCounts: GetAPISearchMatchCounts;
    }
) : GetAPISearchResult
{
    let result: GetAPISearchResult = {
        matches,
        matchCounts: options.matchCounts
    };

    if (notices.length != 0)
        result.notices = notices;
    if (options.scopeLookup)
        result.scopeLookup = options.scopeLookup;
    if (options.scopeGroups && options.scopeGroups.length > 0)
        result.scopeGroups = options.scopeGroups;
    if (options.inheritedScopeOutcome)
        result.inheritedScopeOutcome = options.inheritedScopeOutcome;

    return result;
}

function createMatchCounts(total: number, returned: number) : GetAPISearchMatchCounts
{
    let safeTotal = Math.max(0, total);
    let safeReturned = Math.max(0, Math.min(returned, safeTotal));
    return {
        total: safeTotal,
        returned: safeReturned,
        omitted: Math.max(0, safeTotal - safeReturned)
    };
}

function getSearchIndex() : SearchIndex
{
    let dirtyTypeCacheId = typedb.GetDirtyTypeCacheId();
    if (cachedSearchIndex && cachedDirtyTypeCacheId == dirtyTypeCacheId)
        return cachedSearchIndex;

    cachedSearchIndex = buildSearchIndex();
    cachedDirtyTypeCacheId = dirtyTypeCacheId;
    return cachedSearchIndex;
}

function buildSearchIndex() : SearchIndex
{
    let entries: SearchIndexEntry[] = [];
    let scopeCandidates: ScopeCandidate[] = [];
    let typeEntriesByQualifiedName = new Map<string, SearchIndexEntry>();

    let visitNamespace = function (namespace: typedb.DBNamespace)
    {
        if (!namespace.isRootNamespace() && !isNamespaceApiEmpty(namespace))
        {
            let qualifiedNamespace = namespace.getQualifiedNamespace();
            scopeCandidates.push({
                kind: 'namespace',
                qualifiedName: qualifiedNamespace,
                shortName: namespace.name,
                namespace,
                isClassType: false
            });
        }

        for (let [_, childNamespace] of namespace.childNamespaces)
            visitNamespace(childNamespace);

        namespace.forEachSymbol((symbol) =>
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (shouldSkipMethod(symbol))
                    return;
                entries.push(createMethodEntry(symbol));
                return;
            }

            if (symbol instanceof typedb.DBProperty)
            {
                entries.push(createGlobalPropertyEntry(symbol));
                return;
            }

            if (symbol instanceof typedb.DBType)
                visitType(symbol);
        });
    };

    let visitType = function (dbType: typedb.DBType)
    {
        if (shouldIncludeTypeInSearch(dbType))
        {
            let documentation = normalizeSearchDocumentation(dbType.documentation);
            let qualifiedTypeName = dbType.getQualifiedTypenameInNamespace(null);
            let kind = getTypeKind(dbType);
            let typeEntry = createSearchEntry({
                qualifiedName: qualifiedTypeName,
                kind,
                isCallable: false,
                signature: buildTypeSignature(dbType),
                summary: extractSummary(documentation),
                documentation,
                containerQualifiedName: dbType.namespace && !dbType.namespace.isRootNamespace()
                    ? dbType.namespace.getQualifiedNamespace()
                    : undefined,
                source: getDeclaredSource(dbType.declaredModule),
                filterSource: getDeclaredSource(dbType.declaredModule),
                detailsData: ['type', dbType.name, dbType.namespace && !dbType.namespace.isRootNamespace()
                    ? dbType.namespace.getQualifiedNamespace()
                    : '', kind],
                namespaceQualifiedName: dbType.namespace && !dbType.namespace.isRootNamespace()
                    ? dbType.namespace.getQualifiedNamespace()
                    : ''
            });
            entries.push(typeEntry);
            typeEntriesByQualifiedName.set(qualifiedTypeName, typeEntry);
            scopeCandidates.push({
                kind,
                qualifiedName: qualifiedTypeName,
                shortName: dbType.name,
                dbType,
                isClassType: isClassType(dbType)
            });
        }

        dbType.forEachSymbol((symbol) =>
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (shouldSkipMethod(symbol))
                    return;
                entries.push(createMethodEntry(symbol));
                return;
            }

            if (symbol instanceof typedb.DBProperty)
                entries.push(createTypePropertyEntry(symbol));
        }, false);
    };

    visitNamespace(typedb.GetRootNamespace());
    return {
        entries,
        scopeCandidates,
        typeEntriesByQualifiedName
    };
}

function isNativeBlueprintOverrideTarget(method: typedb.DBMethod) : boolean
{
    return method.containingType != null && method.declaredModule == null && method.isBlueprintEvent;
}

function createMethodEntry(method: typedb.DBMethod) : SearchIndexEntry
{
    let documentation = normalizeSearchDocumentation(method.findAvailableDocumentation());
    let methodArgs = method.args ? method.args.map((arg) => arg.typename) : [];
    let isCallable = method.isProperty !== true && method.isCallable !== false;
    let detailsData: unknown;
    let qualifiedName = '';
    let containerQualifiedName: string | undefined = undefined;
    let namespaceQualifiedName = '';
    let declaringTypeQualifiedName: string | undefined = undefined;
    let mixinTargetQualifiedName: string | undefined = undefined;
    let aliasQualifiedNames: string[] | undefined = undefined;
    let blueprintEventKind = typedb.GetBlueprintEventKind(method);

    if (method.containingType)
    {
        declaringTypeQualifiedName = method.containingType.getQualifiedTypenameInNamespace(null);
        qualifiedName = `${declaringTypeQualifiedName}.${method.name}`;
        containerQualifiedName = declaringTypeQualifiedName;
        namespaceQualifiedName = method.containingType.namespace && !method.containingType.namespace.isRootNamespace()
            ? method.containingType.namespace.getQualifiedNamespace()
            : '';
        detailsData = [
            'method',
            method.containingType.name,
            method.name,
            method.id,
            namespaceQualifiedName,
            methodArgs
        ];
    }
    else
    {
        namespaceQualifiedName = method.namespace && !method.namespace.isRootNamespace()
            ? method.namespace.getQualifiedNamespace()
            : '';
        if (method.isMixin)
        {
            mixinTargetQualifiedName = getMixinTargetQualifiedName(method);
            if (mixinTargetQualifiedName)
                aliasQualifiedNames = [`${mixinTargetQualifiedName}.${method.name}`];
        }
        qualifiedName = namespaceQualifiedName.length > 0
            ? `${namespaceQualifiedName}::${method.name}`
            : method.name;
        containerQualifiedName = namespaceQualifiedName.length > 0 ? namespaceQualifiedName : undefined;
        detailsData = [
            'function',
            qualifiedName,
            method.id,
            methodArgs
        ];
    }

    return createSearchEntry({
        qualifiedName,
        kind: method.containingType ? 'method' : 'function',
        isCallable,
        access: method.access ?? unknownFunctionAccess(),
        ...(isNativeBlueprintOverrideTarget(method) ? { canBlueprintOverride: true } : {}),
        ...(blueprintEventKind !== undefined ? { blueprintEventKind } : {}),
        signature: buildMethodSignature(method),
        summary: extractSummary(documentation),
        documentation,
        containerQualifiedName,
        source: getDeclaredSource(method.declaredModule),
        filterSource: getDeclaredSource(method.declaredModule),
        detailsData,
        namespaceQualifiedName,
        declaringTypeQualifiedName,
        isMixin: method.isMixin,
        mixinTargetQualifiedName,
        aliasQualifiedNames,
        overrideKey: buildMethodOverrideKey(method)
    });
}

function createTypePropertyEntry(property: typedb.DBProperty) : SearchIndexEntry
{
    let documentation = normalizeSearchDocumentation(property.documentation);
    let qualifiedContainer = property.containingType.getQualifiedTypenameInNamespace(null);
    let namespaceQualifiedName = property.containingType.namespace && !property.containingType.namespace.isRootNamespace()
        ? property.containingType.namespace.getQualifiedNamespace()
        : '';

    return createSearchEntry({
        qualifiedName: `${qualifiedContainer}.${property.name}`,
        kind: 'property',
        isCallable: false,
        access: property.access ?? unknownPropertyAccess(),
        signature: property.format(`${qualifiedContainer}.`),
        summary: extractSummary(documentation),
        documentation,
        containerQualifiedName: qualifiedContainer,
        source: getDeclaredSource(property.declaredModule),
        filterSource: getDeclaredSource(property.declaredModule),
        detailsData: ['property', property.containingType.name, property.name],
        namespaceQualifiedName,
        declaringTypeQualifiedName: qualifiedContainer,
        overrideKey: buildPropertyOverrideKey(property)
    });
}

function createGlobalPropertyEntry(property: typedb.DBProperty) : SearchIndexEntry
{
    let documentation = normalizeSearchDocumentation(property.documentation);
    let namespaceQualifiedName = property.namespace && !property.namespace.isRootNamespace()
        ? property.namespace.getQualifiedNamespace()
        : '';
    let qualifiedName = namespaceQualifiedName.length > 0
        ? `${namespaceQualifiedName}::${property.name}`
        : property.name;

    return createSearchEntry({
        qualifiedName,
        kind: 'globalVariable',
        isCallable: false,
        signature: property.format(namespaceQualifiedName.length > 0 ? `${namespaceQualifiedName}::` : ''),
        summary: extractSummary(documentation),
        documentation,
        containerQualifiedName: namespaceQualifiedName.length > 0 ? namespaceQualifiedName : undefined,
        source: getDeclaredSource(property.declaredModule),
        filterSource: getDeclaredSource(property.declaredModule),
        detailsData: ['global', qualifiedName],
        namespaceQualifiedName
    });
}

function createSearchEntry(input: {
    qualifiedName: string;
    kind: ApiSearchKind;
    isCallable: boolean;
    access?: PropertyAccess | FunctionAccess;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    signature: string;
    summary?: string;
    documentation?: string;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    filterSource: ApiSearchSource;
    detailsData?: unknown;
    namespaceQualifiedName: string;
    declaringTypeQualifiedName?: string;
    isMixin?: boolean;
    mixinTargetQualifiedName?: string;
    aliasQualifiedNames?: string[];
    overrideKey?: string;
}) : SearchIndexEntry
{
    let shortName = getShortName(input.qualifiedName, input.kind);
    let shortText = createSearchTextVariant(shortName);
    let qualifiedText = createSearchTextVariant(input.qualifiedName);
    let qualifiedAliasTexts = dedupeSearchTextVariants(input.aliasQualifiedNames, qualifiedText.textLower);
    return {
        qualifiedName: input.qualifiedName,
        kind: input.kind,
        isCallable: input.isCallable,
        access: input.access,
        canBlueprintOverride: input.canBlueprintOverride,
        blueprintEventKind: input.blueprintEventKind,
        signature: input.signature,
        summary: input.summary,
        documentation: input.documentation,
        containerQualifiedName: input.containerQualifiedName,
        source: input.source,
        filterSource: input.filterSource,
        detailsData: input.detailsData,
        shortName,
        shortNameLower: shortText.textLower,
        qualifiedNameLower: qualifiedText.textLower,
        shortText,
        qualifiedText,
        namespaceQualifiedName: input.namespaceQualifiedName,
        declaringTypeQualifiedName: input.declaringTypeQualifiedName,
        isMixin: input.isMixin === true,
        mixinTargetQualifiedName: input.mixinTargetQualifiedName,
        qualifiedAliasTexts,
        overrideKey: input.overrideKey
    };
}

function resolveScope(
    index: SearchIndex,
    scopeName: string,
    includeInheritedFromScopeMode: ScopeInheritanceMode
) : ScopeResolution
{
    let notices: GetAPISearchNotice[] = [];
    let normalizedScope = scopeName.trim();
    let normalizedScopeLower = normalizedScope.toLowerCase();

    let exactQualifiedCandidates = index.scopeCandidates.filter((candidate) => candidate.qualifiedName.toLowerCase() == normalizedScopeLower);
    let candidates = exactQualifiedCandidates;
    let candidateMatchMode: ScopeCandidateMatchMode = 'exact-qualified';
    if (candidates.length == 0)
    {
        let exactShortCandidates = index.scopeCandidates.filter((candidate) => candidate.shortName.toLowerCase() == normalizedScopeLower);
        candidates = exactShortCandidates;
        candidateMatchMode = 'exact-short';
    }
    if (candidates.length == 0)
    {
        let prefixCandidates = index.scopeCandidates.filter((candidate) => candidate.qualifiedName.toLowerCase().startsWith(normalizedScopeLower));
        candidates = prefixCandidates;
        candidateMatchMode = 'prefix';
    }
    candidates = dedupeScopeCandidates(candidates);

    let scopeLookup: GetAPISearchScopeLookup = {
        requestedScope: normalizedScope
    };

    if (candidates.length == 0)
    {
        return {
            scopes: [],
            notices,
            scopeLookup,
            inheritedScopeOutcome: getInvalidInheritedScopeOutcome(includeInheritedFromScopeMode, 'ignored_scope_not_found')
        };
    }

    let mergedScopeResolution = tryResolveMergedSameNameScope(
        candidates,
        normalizedScope,
        includeInheritedFromScopeMode,
        candidateMatchMode
    );
    if (mergedScopeResolution)
    {
        return {
            ...mergedScopeResolution,
            notices
        };
    }

    if (candidates.length > 1)
    {
        scopeLookup.ambiguousCandidates = candidates
            .map((candidate) => candidate.qualifiedName)
            .sort((left, right) => left.localeCompare(right));
        return {
            scopes: [],
            notices,
            scopeLookup,
            inheritedScopeOutcome: getInvalidInheritedScopeOutcome(includeInheritedFromScopeMode, 'ignored_scope_ambiguous')
        };
    }

    let candidate = candidates[0];
    let resolvedScope = buildResolvedScope(candidate, normalizedScope, includeInheritedFromScopeMode);
    if (!resolvedScope)
    {
        return {
            scopes: [],
            notices,
            scopeLookup,
            inheritedScopeOutcome: getInvalidInheritedScopeOutcome(includeInheritedFromScopeMode, 'ignored_scope_not_found')
        };
    }

    return {
        scopes: [resolvedScope],
        notices,
        scopeLookup: resolvedScope.scopeLookup,
        inheritedScopeOutcome: getInheritedScopeOutcomeForCandidate(candidate, includeInheritedFromScopeMode)
    };
}

function applyNamespaceScope(candidates: SearchCandidate[], namespaceQualifiedName: string) : SearchCandidate[]
{
    return candidates
        .filter((candidate) => isEntryWithinNamespaceScope(candidate.entry, namespaceQualifiedName))
        .map((candidate) => ({
            entry: candidate.entry,
            scopeRelationship: 'declared',
            scopeDistance: 0
        }));
}

function applyTypeScope(
    candidates: SearchCandidate[],
    scope: Extract<ResolvedScope, { kind: 'type' }>,
    notices: GetAPISearchNotice[]
) : SearchCandidate[]
{
    let scopedCandidates: SearchCandidate[] = [];
    let seenOverrideKeys = new Set<string>();
    let inheritanceChain = getScopeInheritanceChain(scope.dbType);
    let typeDistanceByQualifiedName = new Map<string, number>();
    typeDistanceByQualifiedName.set(scope.qualifiedName, 0);
    for (let inheritanceEntry of inheritanceChain)
    {
        if (!typeDistanceByQualifiedName.has(inheritanceEntry.qualifiedName))
            typeDistanceByQualifiedName.set(inheritanceEntry.qualifiedName, inheritanceEntry.distance);
    }

    for (let candidate of candidates)
    {
        let entry = candidate.entry;
        if (entry.qualifiedName == scope.qualifiedName)
        {
            scopedCandidates.push({
                entry,
                scopeRelationship: 'declared',
                scopeDistance: 0
            });
            continue;
        }

        if (entry.declaringTypeQualifiedName == scope.qualifiedName)
        {
            if (entry.overrideKey)
                seenOverrideKeys.add(entry.overrideKey);
            scopedCandidates.push({
                entry,
                scopeRelationship: 'declared',
                scopeDistance: 0
            });
        }
    }

    for (let candidate of candidates)
    {
        let mixinDistance = getMixinScopeDistance(candidate.entry, typeDistanceByQualifiedName);
        if (mixinDistance == null)
            continue;

        scopedCandidates.push({
            entry: candidate.entry,
            scopeRelationship: 'mixin',
            scopeDistance: mixinDistance
        });
    }

    if (!scope.includeInherited)
        return scopedCandidates;

    if (inheritanceChain.length == 0)
    {
        notices.push({
            code: 'SCOPE_INHERITANCE_EMPTY',
            message: `Scope "${scope.qualifiedName}" has no inherited members to expand.`
        });
        return scopedCandidates;
    }

    for (let inheritanceEntry of inheritanceChain)
    {
        for (let candidate of candidates)
        {
            let entry = candidate.entry;
            if (entry.kind != 'method' && entry.kind != 'property')
                continue;
            if (entry.declaringTypeQualifiedName != inheritanceEntry.qualifiedName)
                continue;
            if (entry.overrideKey && seenOverrideKeys.has(entry.overrideKey))
                continue;

            if (entry.overrideKey)
                seenOverrideKeys.add(entry.overrideKey);

            scopedCandidates.push({
                entry,
                scopeRelationship: 'inherited',
                scopeDistance: inheritanceEntry.distance
            });
        }
    }

    return scopedCandidates;
}

function tryResolveMergedSameNameScope(
    candidates: ScopeCandidate[],
    requestedScope: string,
    includeInheritedFromScopeMode: ScopeInheritanceMode,
    candidateMatchMode: ScopeCandidateMatchMode
) : Omit<ScopeResolution, 'notices'> | null
{
    if (candidateMatchMode == 'prefix' || candidates.length != 2)
        return null;

    let qualifiedNames = new Set(candidates.map((candidate) => candidate.qualifiedName.toLowerCase()));
    if (qualifiedNames.size != 1)
        return null;

    let namespaceCandidate = candidates.find((candidate) => candidate.kind == 'namespace');
    let typeCandidate = candidates.find((candidate) => candidate.kind != 'namespace');
    if (!namespaceCandidate || !typeCandidate)
        return null;

    let namespaceScope = buildResolvedScope(namespaceCandidate, requestedScope, 'off');
    let typeScope = buildResolvedScope(typeCandidate, requestedScope, includeInheritedFromScopeMode);
    if (!namespaceScope || !typeScope)
        return null;

    return {
        scopes: [typeScope, namespaceScope],
        scopeLookup: typeScope.scopeLookup,
        inheritedScopeOutcome: getInheritedScopeOutcomeForCandidate(typeCandidate, includeInheritedFromScopeMode),
        hasMergedSameNameScope: true
    };
}

function buildResolvedScope(
    candidate: ScopeCandidate,
    requestedScope: string,
    includeInheritedFromScopeMode: ScopeInheritanceMode
) : ResolvedScope | null
{
    let scopeLookup: GetAPISearchScopeLookup = {
        requestedScope,
        resolvedQualifiedName: candidate.qualifiedName,
        resolvedKind: candidate.kind
    };

    if (candidate.kind == 'namespace')
    {
        if (!candidate.namespace)
            return null;

        return {
            kind: 'namespace',
            qualifiedName: candidate.qualifiedName,
            namespace: candidate.namespace,
            scopeLookup
        };
    }

    if (!candidate.dbType)
        return null;

    return {
        kind: 'type',
        qualifiedName: candidate.qualifiedName,
        dbType: candidate.dbType,
        scopeLookup,
        includeInherited: shouldEnableInheritedScope(candidate, includeInheritedFromScopeMode)
    };
}

function getInheritedScopeOutcomeForCandidate(
    candidate: ScopeCandidate,
    includeInheritedFromScopeMode: ScopeInheritanceMode
) : ApiInheritedScopeOutcome | undefined
{
    if (includeInheritedFromScopeMode == 'off')
        return undefined;
    if (shouldEnableInheritedScope(candidate, includeInheritedFromScopeMode))
        return 'applied';
    return includeInheritedFromScopeMode == 'on' ? 'ignored_scope_not_class' : undefined;
}

function shouldEnableInheritedScope(
    candidate: ScopeCandidate,
    includeInheritedFromScopeMode: ScopeInheritanceMode
) : boolean
{
    return includeInheritedFromScopeMode != 'off'
        && candidate.kind != 'namespace'
        && candidate.isClassType;
}

function getInvalidInheritedScopeOutcome(
    includeInheritedFromScopeMode: ScopeInheritanceMode,
    outcome: Exclude<ApiInheritedScopeOutcome, 'applied'>
) : ApiInheritedScopeOutcome | undefined
{
    return includeInheritedFromScopeMode == 'on' ? outcome : undefined;
}

function applyResolvedScope(
    candidates: SearchCandidate[],
    scope: ResolvedScope,
    notices: GetAPISearchNotice[]
) : SearchCandidate[]
{
    if (scope.kind == 'namespace')
        return applyNamespaceScope(candidates, scope.qualifiedName);
    return applyTypeScope(candidates, scope, notices);
}

function buildRankedScopeGroups(
    baseCandidates: SearchCandidate[],
    scopes: ResolvedScope[],
    notices: GetAPISearchNotice[],
    params: NormalizedSearchParams,
    index: SearchIndex
) : RankedScopeGroup[]
{
    let rankedGroups: RankedScopeGroup[] = [];
    for (let scope of scopes)
    {
        let scopedCandidates = applyResolvedScope(baseCandidates, scope, notices)
            .filter((candidate) => filterCandidate(candidate.entry, params));
        rankedGroups.push({
            scope,
            candidates: rankAndProjectCandidates(scopedCandidates, params, index)
        });
    }
    return rankedGroups;
}

function limitMergedScopeGroups(groups: RankedScopeGroup[], offset: number, limit: number) : LimitedScopeGroup[]
{
    let orderedCandidates: Array<{ groupIndex: number; candidate: SearchCandidate }> = [];
    let nextIndexByGroup = groups.map(() => 0);

    for (let index = 0; index < groups.length; index += 1)
    {
        if (groups[index].candidates.length == 0)
            continue;

        orderedCandidates.push({ groupIndex: index, candidate: groups[index].candidates[0] });
        nextIndexByGroup[index] = 1;
    }

    while (true)
    {
        let bestGroupIndex = -1;
        let bestCandidate: SearchCandidate | null = null;

        for (let index = 0; index < groups.length; index += 1)
        {
            let nextCandidate = groups[index].candidates[nextIndexByGroup[index]];
            if (!nextCandidate)
                continue;

            if (!bestCandidate || compareCandidates(nextCandidate, bestCandidate) < 0)
            {
                bestCandidate = nextCandidate;
                bestGroupIndex = index;
            }
        }

        if (bestGroupIndex == -1 || !bestCandidate)
            break;

        orderedCandidates.push({ groupIndex: bestGroupIndex, candidate: bestCandidate });
        nextIndexByGroup[bestGroupIndex] += 1;
    }

    let selectedByGroup = groups.map(() => new Array<SearchCandidate>());
    for (let selected of orderedCandidates.slice(offset, offset + limit))
        selectedByGroup[selected.groupIndex].push(selected.candidate);

    return groups.map((group, index) => ({
        scope: group.scope,
        candidates: selectedByGroup[index],
        totalMatches: group.candidates.length,
        omittedMatches: Math.max(0, group.candidates.length - selectedByGroup[index].length)
    }));
}

function buildScopeGroupsFromLimitedGroups(
    limitedGroups: LimitedScopeGroup[],
    scopes: ResolvedScope[],
    includeDocs: boolean
) : GetAPISearchScopeGroup[]
{
    let groupsByQualifiedName = new Map<string, LimitedScopeGroup>();
    for (let group of limitedGroups)
        groupsByQualifiedName.set(getScopeGroupKey(group.scope), group);

    return scopes.map((scope) =>
    {
        let limitedGroup = groupsByQualifiedName.get(getScopeGroupKey(scope));
        let candidates = limitedGroup ? limitedGroup.candidates : [];
        let totalMatches = limitedGroup ? limitedGroup.totalMatches : 0;
        let omittedMatches = limitedGroup ? limitedGroup.omittedMatches : 0;
        return {
            scope: buildResolvedScopeInfo(scope),
            matches: candidates.map((candidate) => buildMatch(candidate, includeDocs)),
            totalMatches,
            omittedMatches
        };
    });
}

function getScopeGroupKey(scope: ResolvedScope) : string
{
    return `${getResolvedScopeKind(scope)}|${scope.qualifiedName}`;
}

function buildResolvedScopeInfo(scope: ResolvedScope) : GetAPISearchResolvedScope
{
    return {
        requestedScope: scope.scopeLookup.requestedScope,
        resolvedQualifiedName: scope.qualifiedName,
        resolvedKind: getResolvedScopeKind(scope)
    };
}

function getResolvedScopeKind(scope: ResolvedScope) : ApiSearchScopeKind
{
    if (scope.kind == 'namespace')
        return 'namespace';
    return getTypeKind(scope.dbType);
}

function getScopeInheritanceChain(dbType: typedb.DBType) : Array<{ qualifiedName: string; distance: number }>
{
    let result: Array<{ qualifiedName: string; distance: number }> = [];
    let seen = new Set<string>();
    let current = dbType;
    let distance = 0;

    while (true)
    {
        let parent = resolveDirectSuperType(current);
        if (!parent)
            break;

        let qualifiedName = parent.getQualifiedTypenameInNamespace(null);
        if (seen.has(qualifiedName))
            break;

        seen.add(qualifiedName);
        distance += 1;
        result.push({
            qualifiedName,
            distance
        });
        current = parent;
    }

    return result;
}

function getMixinScopeDistance(
    entry: SearchIndexEntry,
    typeDistanceByQualifiedName: Map<string, number>
) : number | null
{
    if (!entry.isMixin || !entry.mixinTargetQualifiedName)
        return null;

    let distance = typeDistanceByQualifiedName.get(entry.mixinTargetQualifiedName);
    return typeof distance == 'number' ? distance : null;
}

function resolveDirectSuperType(dbType: typedb.DBType) : typedb.DBType | null
{
    if (!dbType)
        return null;
    if (dbType.supertype)
    {
        let superType = typedb.LookupType(dbType.namespace, dbType.supertype) ?? typedb.GetTypeByName(dbType.supertype);
        if (superType)
            return superType;
    }
    if (dbType.unrealsuper)
    {
        let unrealSuper = typedb.LookupType(dbType.namespace, dbType.unrealsuper) ?? typedb.GetTypeByName(dbType.unrealsuper);
        if (unrealSuper)
            return unrealSuper;
    }
    return null;
}

function filterCandidate(entry: SearchIndexEntry, params: NormalizedSearchParams) : boolean
{
    if (!params.searchKinds.has(entry.kind))
        return false;
    if (params.source != 'both' && entry.filterSource != 'both' && entry.filterSource != params.source)
        return false;
    return true;
}

function isTinySmartQuery(smartQuery: ParsedSmartQuery) : boolean
{
    return smartQuery.searchableCharCount < QUERY_TOO_SHORT_THRESHOLD;
}

function rankCandidates(candidates: SearchCandidate[], params: NormalizedSearchParams) : SearchCandidate[]
{
    if (params.mode == 'regex')
    {
        let regex = buildRegex(params.query);
        let scored = new Array<SearchCandidate>();
        for (let candidate of candidates)
        {
            let sortKey = findRegexSortKey(candidate.entry, regex);
            if (!sortKey)
                continue;

            scored.push({
                ...candidate,
                matchSort: applyScopeBiasToSortKey(sortKey, candidate)
            });
        }
        scored.sort(compareCandidates);
        return scored;
    }

    let smartQueries = params.smartQueries?.filter((query) => !isTinySmartQuery(query)) ?? [];
    let scored = new Array<SearchCandidate>();

    for (let candidate of candidates)
    {
        let match = scoreSmartMatch(candidate.entry, smartQueries);
        if (!match)
            continue;

        scored.push({
            ...candidate,
            matchReason: match.reason,
            matchSort: applyScopeBiasToSortKey(match.sortKey, candidate)
        });
    }

    scored.sort(compareCandidates);
    return scored;
}

function rankAndProjectCandidates(
    candidates: SearchCandidate[],
    params: NormalizedSearchParams,
    index: SearchIndex
) : SearchCandidate[]
{
    let rankedCandidates = rankCandidates(candidates, params);
    if (params.symbolLevel != 'type')
        return rankedCandidates;
    return projectToTypeLevelCandidates(rankedCandidates, params, index);
}

function projectToTypeLevelCandidates(
    candidates: SearchCandidate[],
    params: NormalizedSearchParams,
    index: SearchIndex
) : SearchCandidate[]
{
    let bestCandidateByType = new Map<string, SearchCandidate>();

    for (let projectedRank = 0; projectedRank < candidates.length; projectedRank += 1)
    {
        let projectedCandidate = projectCandidateToTypeLevel(candidates[projectedRank], params, index, projectedRank);
        if (!projectedCandidate)
            continue;

        let key = projectedCandidate.entry.qualifiedName;
        let existing = bestCandidateByType.get(key);
        if (!existing || shouldReplaceProjectedTypeCandidate(existing, projectedCandidate))
            bestCandidateByType.set(key, projectedCandidate);
    }

    let projectedCandidates = Array.from(bestCandidateByType.values());
    projectedCandidates.sort(compareProjectedTypeCandidates);
    return projectedCandidates;
}

function projectCandidateToTypeLevel(
    candidate: SearchCandidate,
    params: NormalizedSearchParams,
    index: SearchIndex,
    projectedRank: number
) : SearchCandidate | null
{
    let projection = resolveTypeLevelProjection(candidate.entry, params, index);
    if (!projection)
        return null;

    return {
        entry: projection.typeEntry,
        scopeRelationship: candidate.scopeRelationship,
        scopeDistance: candidate.scopeDistance,
        matchReason: candidate.matchReason,
        matchSort: candidate.matchSort,
        matchedBy: projection.matchedBy,
        matchedByQualifiedName: projection.matchedByQualifiedName,
        matchedByKind: projection.matchedByKind,
        projectedRank
    };
}

function resolveTypeLevelProjection(
    entry: SearchIndexEntry,
    params: NormalizedSearchParams,
    index: SearchIndex
) : {
    typeEntry: SearchIndexEntry;
    matchedBy: ApiSearchMatchedBy;
    matchedByQualifiedName: string;
    matchedByKind: ApiSearchKind;
} | null
{
    if (isTypeSearchKind(entry.kind))
    {
        if (!shouldIncludeProjectedTypeKind(entry.kind, params))
            return null;

        return {
            typeEntry: entry,
            matchedBy: 'self',
            matchedByQualifiedName: entry.qualifiedName,
            matchedByKind: entry.kind
        };
    }

    if (entry.kind == 'method' || entry.kind == 'property')
    {
        if (!entry.declaringTypeQualifiedName)
            return null;

        let typeEntry = index.typeEntriesByQualifiedName.get(entry.declaringTypeQualifiedName);
        if (!typeEntry || !shouldIncludeProjectedTypeKind(typeEntry.kind, params))
            return null;

        return {
            typeEntry,
            matchedBy: 'member',
            matchedByQualifiedName: entry.qualifiedName,
            matchedByKind: entry.kind
        };
    }

    if (entry.isMixin && entry.mixinTargetQualifiedName)
    {
        let typeEntry = index.typeEntriesByQualifiedName.get(entry.mixinTargetQualifiedName);
        if (!typeEntry || !shouldIncludeProjectedTypeKind(typeEntry.kind, params))
            return null;

        return {
            typeEntry,
            matchedBy: 'mixin',
            matchedByQualifiedName: entry.qualifiedName,
            matchedByKind: entry.kind
        };
    }

    return null;
}

function shouldIncludeProjectedTypeKind(kind: ApiSearchKind, params: NormalizedSearchParams) : boolean
{
    if (!isTypeSearchKind(kind))
        return false;
    if (!params.typeResultKinds)
        return true;
    return params.typeResultKinds.has(kind);
}

function isTypeSearchKind(kind: ApiSearchKind) : kind is ApiSearchTypeKind
{
    return kind == 'class' || kind == 'struct' || kind == 'enum';
}

function shouldReplaceProjectedTypeCandidate(
    existing: SearchCandidate,
    incoming: SearchCandidate
) : boolean
{
    let existingIsSelf = existing.matchedBy == 'self';
    let incomingIsSelf = incoming.matchedBy == 'self';
    if (existingIsSelf != incomingIsSelf)
        return incomingIsSelf;
    return compareProjectedTypeCandidates(incoming, existing) < 0;
}

function compareProjectedTypeCandidates(left: SearchCandidate, right: SearchCandidate) : number
{
    let compared = compareCandidates(left, right);
    if (compared != 0)
        return compared;

    let leftProjectedRank = left.projectedRank ?? Number.MAX_SAFE_INTEGER;
    let rightProjectedRank = right.projectedRank ?? Number.MAX_SAFE_INTEGER;
    if (leftProjectedRank != rightProjectedRank)
        return leftProjectedRank - rightProjectedRank;

    return 0;
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate) : number
{
    let leftExactQualifiedPriority = left.matchSort?.exactQualifiedPriority ?? 0;
    let rightExactQualifiedPriority = right.matchSort?.exactQualifiedPriority ?? 0;
    if (leftExactQualifiedPriority != rightExactQualifiedPriority)
        return rightExactQualifiedPriority - leftExactQualifiedPriority;

    let leftQualifiedPriorityEnabled = left.matchSort?.qualifiedPriorityEnabled ?? 0;
    let rightQualifiedPriorityEnabled = right.matchSort?.qualifiedPriorityEnabled ?? 0;
    if (leftQualifiedPriorityEnabled != rightQualifiedPriorityEnabled)
        return rightQualifiedPriorityEnabled - leftQualifiedPriorityEnabled;

    if (leftQualifiedPriorityEnabled != 0 && rightQualifiedPriorityEnabled != 0)
    {
        let leftQualifiedStart = left.matchSort?.qualifiedStart ?? Number.MAX_SAFE_INTEGER;
        let rightQualifiedStart = right.matchSort?.qualifiedStart ?? Number.MAX_SAFE_INTEGER;
        if (leftQualifiedStart != rightQualifiedStart)
            return leftQualifiedStart - rightQualifiedStart;

        let leftQualifiedGap = left.matchSort?.qualifiedTotalGap ?? Number.MAX_SAFE_INTEGER;
        let rightQualifiedGap = right.matchSort?.qualifiedTotalGap ?? Number.MAX_SAFE_INTEGER;
        if (leftQualifiedGap != rightQualifiedGap)
            return leftQualifiedGap - rightQualifiedGap;

        let leftQualifiedSpan = left.matchSort?.qualifiedSpan ?? Number.MAX_SAFE_INTEGER;
        let rightQualifiedSpan = right.matchSort?.qualifiedSpan ?? Number.MAX_SAFE_INTEGER;
        if (leftQualifiedSpan != rightQualifiedSpan)
            return leftQualifiedSpan - rightQualifiedSpan;

        let leftRelationshipOrder = getScopeRelationshipOrder(left.scopeRelationship);
        let rightRelationshipOrder = getScopeRelationshipOrder(right.scopeRelationship);
        if (leftRelationshipOrder != rightRelationshipOrder)
            return leftRelationshipOrder - rightRelationshipOrder;

        let leftDistance = left.scopeDistance ?? 0;
        let rightDistance = right.scopeDistance ?? 0;
        if (leftDistance != rightDistance)
            return leftDistance - rightDistance;

        if (left.entry.qualifiedName.length != right.entry.qualifiedName.length)
            return left.entry.qualifiedName.length - right.entry.qualifiedName.length;
    }

    let leftReasonRank = left.matchSort?.reasonRank ?? 0;
    let rightReasonRank = right.matchSort?.reasonRank ?? 0;
    if (leftReasonRank != rightReasonRank)
        return rightReasonRank - leftReasonRank;

    let leftStart = left.matchSort?.start ?? Number.MAX_SAFE_INTEGER;
    let rightStart = right.matchSort?.start ?? Number.MAX_SAFE_INTEGER;
    if (leftStart != rightStart)
        return leftStart - rightStart;

    let leftGap = left.matchSort?.totalGap ?? Number.MAX_SAFE_INTEGER;
    let rightGap = right.matchSort?.totalGap ?? Number.MAX_SAFE_INTEGER;
    if (leftGap != rightGap)
        return leftGap - rightGap;

    let leftSpan = left.matchSort?.span ?? Number.MAX_SAFE_INTEGER;
    let rightSpan = right.matchSort?.span ?? Number.MAX_SAFE_INTEGER;
    if (leftSpan != rightSpan)
        return leftSpan - rightSpan;

    let leftViewPriority = left.matchSort?.viewPriority ?? Number.MAX_SAFE_INTEGER;
    let rightViewPriority = right.matchSort?.viewPriority ?? Number.MAX_SAFE_INTEGER;
    if (leftViewPriority != rightViewPriority)
        return leftViewPriority - rightViewPriority;

    let leftKindOrder = kindOrder[left.entry.kind] ?? 999;
    let rightKindOrder = kindOrder[right.entry.kind] ?? 999;
    if (leftKindOrder != rightKindOrder)
        return leftKindOrder - rightKindOrder;

    let leftRelationshipOrder = getScopeRelationshipOrder(left.scopeRelationship);
    let rightRelationshipOrder = getScopeRelationshipOrder(right.scopeRelationship);
    if (leftRelationshipOrder != rightRelationshipOrder)
        return leftRelationshipOrder - rightRelationshipOrder;

    let leftDistance = left.scopeDistance ?? 0;
    let rightDistance = right.scopeDistance ?? 0;
    if (leftDistance != rightDistance)
        return leftDistance - rightDistance;

    if (left.entry.qualifiedName.length != right.entry.qualifiedName.length)
        return left.entry.qualifiedName.length - right.entry.qualifiedName.length;

    return left.entry.qualifiedName.localeCompare(right.entry.qualifiedName);
}

function isEntryCallable(entry: SearchIndexEntry) : boolean
{
    return entry.isCallable;
}

function scoreSmartMatch(
    entry: SearchIndexEntry,
    queries: ParsedSmartQuery[]
) : SearchMatchOutcome | null
{
    let bestMatch : SearchMatchOutcome | null = null;
    for (let index = 0; index < queries.length; index += 1)
        bestMatch = pickBetterMatch(bestMatch, scoreSmartBranch(entry, queries[index]));
    return bestMatch;
}

function scoreSmartBranch(entry: SearchIndexEntry, query: ParsedSmartQuery) : SearchMatchOutcome | null
{
    if (query.searchableCharCount == 0 || query.segments.length == 0)
        return null;
    if (query.requiresCallable && !isEntryCallable(entry))
        return null;

    let exactMatch = scoreSmartExactMatch(entry, query);
    if (exactMatch)
        return exactMatch;

    return scoreSmartOrderedViewsMatch(entry, query);
}

function candidateScopeScoreBias(candidate: SearchCandidate) : number
{
    let distancePenalty = Math.min(candidate.scopeDistance ?? 0, 4) * 2;
    if (candidate.scopeRelationship == 'declared')
        return 24 - distancePenalty;
    if (candidate.scopeRelationship == 'mixin')
        return 16 - distancePenalty;
    if (candidate.scopeRelationship == 'inherited')
        return 8 - distancePenalty;
    return 0;
}

function getScopeRelationshipOrder(value: ApiSearchScopeRelationship | undefined) : number
{
    if (value == 'declared')
        return 0;
    if (value == 'mixin')
        return 1;
    if (value == 'inherited')
        return 2;
    return 3;
}

function applyScopeBiasToSortKey(sortKey: SearchMatchSortKey, candidate: SearchCandidate) : SearchMatchSortKey
{
    let scopeBias = candidateScopeScoreBias(candidate);
    return {
        ...sortKey,
        qualifiedStart: sortKey.qualifiedPriorityEnabled != 0
            ? Math.max(0, sortKey.qualifiedStart - scopeBias)
            : sortKey.qualifiedStart,
        start: Math.max(0, sortKey.start - scopeBias)
    };
}

function createSearchMatchOutcome(
    reason: SearchMatchReason,
    start: number,
    totalGap: number,
    span: number,
    viewPriority: number
) : SearchMatchOutcome
{
    return {
        reason,
        sortKey: {
            reasonRank: getSearchMatchReasonRank(reason),
            qualifiedPriorityEnabled: 0,
            exactQualifiedPriority: 0,
            qualifiedStart: Number.MAX_SAFE_INTEGER,
            qualifiedTotalGap: Number.MAX_SAFE_INTEGER,
            qualifiedSpan: Number.MAX_SAFE_INTEGER,
            start,
            totalGap,
            span,
            viewPriority
        }
    };
}

function applyQualifiedPriorityToOutcome(
    outcome: SearchMatchOutcome,
    qualifiedMatch: StructuredMatchState | null,
    exactQualifiedPriority: boolean
) : SearchMatchOutcome
{
    return {
        reason: outcome.reason,
        sortKey: {
            ...outcome.sortKey,
            qualifiedPriorityEnabled: 1,
            exactQualifiedPriority: exactQualifiedPriority ? 1 : 0,
            qualifiedStart: qualifiedMatch ? qualifiedMatch.start : Number.MAX_SAFE_INTEGER,
            qualifiedTotalGap: qualifiedMatch ? qualifiedMatch.totalGap : Number.MAX_SAFE_INTEGER,
            qualifiedSpan: qualifiedMatch ? qualifiedMatch.end - qualifiedMatch.start : Number.MAX_SAFE_INTEGER
        }
    };
}

function getSearchMatchReasonRank(reason: SearchMatchReason) : number
{
    if (reason == 'exact-qualified')
        return 5;
    if (reason == 'exact-short')
        return 4;
    if (reason == 'boundary-ordered')
        return 3;
    if (reason == 'ordered-wildcard')
        return 2;
    if (reason == 'short-ordered')
        return 1;
    return 1;
}

function buildStructuredVariantMatch(
    variant: SearchTextVariant,
    query: ParsedSmartQuery,
    viewPriority: number
) : SearchMatchOutcome | null
{
    let structuredMatch = findStructuredMatch(variant, query);
    if (!structuredMatch)
        return null;

    let reason: SearchMatchReason;
    if (viewPriority == 2)
        reason = 'short-ordered';
    else if (query.hasStrongSeparator)
        reason = 'boundary-ordered';
    else
        reason = 'ordered-wildcard';

    return createSearchMatchOutcome(
        reason,
        structuredMatch.start,
        structuredMatch.totalGap,
        structuredMatch.end - structuredMatch.start,
        viewPriority
    );
}

function pickBetterMatch(left: SearchMatchOutcome | null, right: SearchMatchOutcome | null) : SearchMatchOutcome | null
{
    if (!left)
        return right;
    if (!right)
        return left;

    if (left.sortKey.reasonRank != right.sortKey.reasonRank)
        return left.sortKey.reasonRank > right.sortKey.reasonRank ? left : right;
    if (left.sortKey.start != right.sortKey.start)
        return left.sortKey.start < right.sortKey.start ? left : right;
    if (left.sortKey.totalGap != right.sortKey.totalGap)
        return left.sortKey.totalGap < right.sortKey.totalGap ? left : right;
    if (left.sortKey.span != right.sortKey.span)
        return left.sortKey.span < right.sortKey.span ? left : right;
    if (left.sortKey.viewPriority != right.sortKey.viewPriority)
        return left.sortKey.viewPriority < right.sortKey.viewPriority ? left : right;
    return left;
}

function parseSmartQueries(query: string) : ParsedSmartQuery[]
{
    let rawBranches = query.split('|');
    if (rawBranches.length == 0)
        return [parseSmartQuery(query)];

    let parsedQueries = new Array<ParsedSmartQuery>();
    for (let branch of rawBranches)
    {
        let trimmedBranch = branch.trim();
        if (trimmedBranch.length == 0)
            throw new ApiSearchValidationError("Invalid params. 'query' contains an empty smart OR branch.");
        parsedQueries.push(parseSmartQuery(trimmedBranch));
    }
    return parsedQueries;
}

function parseSmartQuery(query: string) : ParsedSmartQuery
{
    let raw = query.trim();
    let requiresCallable = false;
    if (raw.endsWith('()'))
    {
        raw = raw.slice(0, -2).trimEnd();
        requiresCallable = true;
    }
    else if (raw.endsWith('('))
    {
        raw = raw.slice(0, -1).trimEnd();
        requiresCallable = true;
    }

    let requiresLeafTermination = false;
    if (raw.endsWith(';'))
    {
        raw = raw.slice(0, -1).trimEnd();
        requiresLeafTermination = true;
    }

    let tokens = raw.match(/::|\.|\s+|[^.\s:]+/g) ?? [];
    let segments: string[] = [];
    let connectors: SearchConnector[] = [];
    let pendingConnector: SearchConnector | null = null;
    let hasStrongSeparator = false;

    for (let token of tokens)
    {
        if (token.trim().length == 0)
        {
            if (segments.length > 0 && pendingConnector == null)
                pendingConnector = 'space';
            continue;
        }

        if (token == '::')
        {
            if (segments.length > 0)
            {
                pendingConnector = 'namespace';
                hasStrongSeparator = true;
            }
            continue;
        }

        if (token == '.')
        {
            if (segments.length > 0)
            {
                pendingConnector = 'member';
                hasStrongSeparator = true;
            }
            continue;
        }

        let normalizedSegment = token.toLowerCase();
        if (normalizedSegment.length == 0)
            continue;

        if (segments.length > 0)
            connectors.push(pendingConnector ?? 'space');
        segments.push(normalizedSegment);
        pendingConnector = null;
    }

    return {
        raw,
        rawLower: raw.toLowerCase(),
        segments,
        connectors,
        hasStrongSeparator,
        searchableCharCount: segments.reduce((total, segment) => total + segment.length, 0),
        requiresCallable,
        requiresLeafTermination
    };
}

function scoreSmartExactMatch(entry: SearchIndexEntry, query: ParsedSmartQuery) : SearchMatchOutcome | null
{
    let qualifiedStructuredMatch = findStructuredMatch(entry.qualifiedText, query);

    if (entry.qualifiedName == query.raw || entry.qualifiedNameLower == query.rawLower)
    {
        return applyQualifiedPriorityToOutcome(
            createSearchMatchOutcome('exact-qualified', 0, 0, entry.qualifiedName.length, 0),
            qualifiedStructuredMatch,
            true
        );
    }

    if (entry.shortName == query.raw || entry.shortNameLower == query.rawLower)
    {
        return applyQualifiedPriorityToOutcome(
            createSearchMatchOutcome('exact-short', 0, 0, entry.shortName.length, 2),
            qualifiedStructuredMatch,
            false
        );
    }

    for (let alias of entry.qualifiedAliasTexts)
    {
        if (alias.text == query.raw || alias.textLower == query.rawLower)
        {
            return applyQualifiedPriorityToOutcome(
                createSearchMatchOutcome('exact-qualified', 0, 0, alias.text.length, 1),
                qualifiedStructuredMatch,
                false
            );
        }
    }

    return null;
}

function scoreSmartOrderedViewsMatch(entry: SearchIndexEntry, query: ParsedSmartQuery) : SearchMatchOutcome | null
{
    let qualifiedStructuredMatch = findStructuredMatch(entry.qualifiedText, query);
    let bestMatch = pickBetterMatch(
        buildStructuredVariantMatch(entry.qualifiedText, query, 0),
        buildStructuredVariantMatch(entry.shortText, query, 2)
    );
    for (let alias of entry.qualifiedAliasTexts)
        bestMatch = pickBetterMatch(bestMatch, buildStructuredVariantMatch(alias, query, 1));

    if (!bestMatch)
        return null;

    return applyQualifiedPriorityToOutcome(bestMatch, qualifiedStructuredMatch, false);
}

type StructuredMatchState = {
    start: number;
    end: number;
    totalGap: number;
};

function findStructuredMatch(variant: SearchTextVariant, query: ParsedSmartQuery) : StructuredMatchState | null
{
    if (query.segments.length == 0)
        return null;

    return findStructuredMatchFrom(variant, query, 0, 0, null);
}

function findStructuredMatchFrom(
    variant: SearchTextVariant,
    query: ParsedSmartQuery,
    segmentIndex: number,
    searchStart: number,
    previous: StructuredMatchState | null
) : StructuredMatchState | null
{
    let segment = query.segments[segmentIndex];
    let bestMatch: StructuredMatchState | null = null;
    let nextStart = searchStart;

    while (nextStart <= variant.textLower.length - segment.length)
    {
        let foundIndex = variant.textLower.indexOf(segment, nextStart);
        if (foundIndex == -1)
            break;

        if (previous)
        {
            let connector = query.connectors[segmentIndex - 1];
            if (!connectorMatches(variant.boundaries, connector, previous.end, foundIndex))
            {
                nextStart = foundIndex + 1;
                continue;
            }
        }

        let currentEnd = foundIndex + segment.length;
        if (segmentIndex == query.segments.length - 1
            && query.requiresLeafTermination
            && currentEnd < variant.text.length
            && isIdentifierContinuationCharacter(variant.text[currentEnd]))
        {
            nextStart = foundIndex + 1;
            continue;
        }

        let currentMatch: StructuredMatchState = {
            start: previous ? previous.start : foundIndex,
            end: currentEnd,
            totalGap: previous ? previous.totalGap + Math.max(0, foundIndex - previous.end) : 0
        };

        let resolved = segmentIndex == query.segments.length - 1
            ? currentMatch
            : findStructuredMatchFrom(variant, query, segmentIndex + 1, currentEnd, currentMatch);
        if (resolved)
            bestMatch = pickBetterStructuredState(bestMatch, resolved);

        nextStart = foundIndex + 1;
    }

    return bestMatch;
}

function pickBetterStructuredState(
    left: StructuredMatchState | null,
    right: StructuredMatchState | null
) : StructuredMatchState | null
{
    if (!left)
        return right;
    if (!right)
        return left;
    if (left.start != right.start)
        return left.start < right.start ? left : right;
    if (left.totalGap != right.totalGap)
        return left.totalGap < right.totalGap ? left : right;

    let leftSpan = left.end - left.start;
    let rightSpan = right.end - right.start;
    if (leftSpan != rightSpan)
        return leftSpan < rightSpan ? left : right;
    return left;
}

function connectorMatches(
    boundaries: SearchBoundary[],
    connector: SearchConnector,
    previousEnd: number,
    nextStart: number
) : boolean
{
    if (connector == 'space')
        return true;

    let boundaryKind: SearchBoundaryKind = connector == 'namespace' ? 'namespace' : 'member';
    return boundaries.some((boundary) =>
        boundary.kind == boundaryKind
        && boundary.start >= previousEnd
        && boundary.end <= nextStart
    );
}

function isIdentifierContinuationCharacter(value: string) : boolean
{
    return (value >= 'a' && value <= 'z')
        || (value >= 'A' && value <= 'Z')
        || (value >= '0' && value <= '9')
        || value == '_';
}

function buildMatch(candidate: SearchCandidate, includeDocs: boolean) : GetAPISearchMatch
{
    let match: GetAPISearchMatch = {
        qualifiedName: candidate.entry.qualifiedName,
        kind: candidate.entry.kind,
        signature: candidate.entry.signature,
        source: candidate.entry.source
    };

    if (candidate.matchReason)
        match.matchReason = candidate.matchReason;
    if (candidate.entry.summary)
        match.summary = candidate.entry.summary;
    if (includeDocs && candidate.entry.documentation)
        match.documentation = candidate.entry.documentation;
    if (candidate.entry.containerQualifiedName)
        match.containerQualifiedName = candidate.entry.containerQualifiedName;
    if (candidate.entry.access !== undefined)
        match.access = candidate.entry.access;
    if (candidate.entry.canBlueprintOverride)
        match.canBlueprintOverride = true;
    if (candidate.entry.blueprintEventKind !== undefined)
        match.blueprintEventKind = candidate.entry.blueprintEventKind;
    if (candidate.entry.isMixin)
        match.isMixin = true;
    if (candidate.scopeRelationship)
        match.scopeRelationship = candidate.scopeRelationship;
    if (typeof candidate.scopeDistance === 'number')
        match.scopeDistance = candidate.scopeDistance;
    if (candidate.matchedBy)
        match.matchedBy = candidate.matchedBy;
    if (candidate.matchedByQualifiedName)
        match.matchedByQualifiedName = candidate.matchedByQualifiedName;
    if (candidate.matchedByKind)
        match.matchedByKind = candidate.matchedByKind;
    if (candidate.entry.detailsData !== undefined)
        match.detailsData = candidate.entry.detailsData;

    return match;
}

function isEntryWithinNamespaceScope(entry: SearchIndexEntry, namespaceQualifiedName: string) : boolean
{
    if (entry.declaringTypeQualifiedName)
        return entry.declaringTypeQualifiedName.startsWith(namespaceQualifiedName + '::');

    if (entry.kind == 'class' || entry.kind == 'struct' || entry.kind == 'enum')
        return entry.qualifiedName.startsWith(namespaceQualifiedName + '::');

    if (entry.namespaceQualifiedName.length == 0)
        return false;

    return entry.namespaceQualifiedName == namespaceQualifiedName || entry.namespaceQualifiedName.startsWith(namespaceQualifiedName + '::');
}

function isNamespaceApiEmpty(namespace: typedb.DBNamespace) : boolean
{
    return namespace.childNamespaces.size == 0 && namespace.symbols.size == 0;
}

function shouldIncludeTypeInSearch(dbType: typedb.DBType) : boolean
{
    return !dbType.isDelegate
        && !dbType.isEvent
        && !dbType.isPrimitive
        && !dbType.isTemplateInstantiation;
}

function shouldSkipMethod(method: typedb.DBMethod) : boolean
{
    if (method.isConstructor && (!method.args || method.args.length == 0))
        return true;
    if (method.isConstructor && method.args && method.args.length == 1)
        return true;
    if (method.isConstructor)
    {
        let ctorType = getConstructorOwnerType(method);
        if (ctorType && (ctorType.isDelegate || ctorType.isEvent))
            return true;
    }
    if (method.name.startsWith('op'))
        return true;
    return false;
}

function getConstructorOwnerType(method: typedb.DBMethod) : typedb.DBType | null
{
    if (method.containingType)
        return method.containingType;

    if (method.namespace)
    {
        let shadowed = method.namespace.getShadowedType();
        if (shadowed)
            return shadowed;
    }

    if (method.returnType)
    {
        let lookupNamespace = method.namespace;
        if (lookupNamespace && lookupNamespace.isRootNamespace())
            lookupNamespace = null;
        let found = typedb.LookupType(lookupNamespace, method.returnType);
        if (found)
            return found;
        found = typedb.GetTypeByName(method.returnType);
        if (found)
            return found;
    }

    if (method.name)
    {
        let found = typedb.GetTypeByName(method.name);
        if (found)
            return found;
    }

    return null;
}

function buildMethodSignature(method: typedb.DBMethod) : string
{
    if (method.containingType)
        return method.format(method.containingType.getQualifiedTypenameInNamespace(null) + '.');
    if (method.isMixin && method.args && method.args.length > 0)
        return method.format(method.args[0].typename + '.', true);
    if (method.namespace && !method.namespace.isRootNamespace())
        return method.format(method.namespace.getQualifiedNamespace() + '::');
    return method.format();
}

function getMixinTargetQualifiedName(method: typedb.DBMethod) : string | undefined
{
    if (!method.isMixin || !method.args || method.args.length == 0)
        return undefined;

    let mixinTargetName = typedb.CleanTypeName(method.args[0].typename);
    let lookupNamespace = method.namespace;
    if (lookupNamespace && lookupNamespace.isRootNamespace())
        lookupNamespace = null;

    let mixinTarget = typedb.LookupType(lookupNamespace, mixinTargetName) ?? typedb.GetTypeByName(mixinTargetName);
    if (mixinTarget)
        return mixinTarget.getQualifiedTypenameInNamespace(null);

    return mixinTargetName.length > 0 ? mixinTargetName : undefined;
}

function buildTypeSignature(dbType: typedb.DBType) : string
{
    let kind = dbType.isEnum ? 'enum' : (dbType.isStruct ? 'struct' : 'class');
    return `${kind} ${dbType.getQualifiedTypenameInNamespace(null)}`;
}

function buildMethodOverrideKey(method: typedb.DBMethod) : string
{
    let args = method.args ? method.args.map((arg) => typedb.CleanTypeName(arg.typename)).join(',') : '';
    return `method|${method.name}|${typedb.CleanTypeName(method.returnType ?? 'void')}|${args}`;
}

function buildPropertyOverrideKey(property: typedb.DBProperty) : string
{
    return `property|${property.name}`;
}

function getTypeKind(dbType: typedb.DBType) : 'class' | 'struct' | 'enum'
{
    if (dbType.isEnum)
        return 'enum';
    if (dbType.isStruct)
        return 'struct';
    return 'class';
}

function isClassType(dbType: typedb.DBType) : boolean
{
    return !dbType.isPrimitive
        && !dbType.isEnum
        && !dbType.isStruct
        && !dbType.isDelegate
        && !dbType.isEvent;
}

function getDeclaredSource(declaredModule: string | null | undefined) : ApiSearchMatchSource
{
    return typeof declaredModule == 'string' && declaredModule.length > 0 ? 'script' : 'native';
}

function getNamespaceSource(namespace: typedb.DBNamespace) : { source: ApiSearchMatchSource; filterSource: ApiSearchSource }
{
    let hasScript = false;
    let hasNative = false;
    for (let declaration of namespace.declarations)
    {
        if (typeof declaration.declaredModule == 'string' && declaration.declaredModule.length > 0)
            hasScript = true;
        else
            hasNative = true;
    }

    if (hasScript && hasNative)
    {
        return {
            source: 'script',
            filterSource: 'both'
        };
    }

    if (hasScript)
    {
        return {
            source: 'script',
            filterSource: 'script'
        };
    }

    return {
        source: 'native',
        filterSource: 'native'
    };
}

function extractSummary(documentation: string | null | undefined) : string | undefined
{
    if (!documentation)
        return undefined;

    let lines = documentation
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length == 0)
        return undefined;

    let summary = lines[0];
    if (summary.length > 220)
        return summary.substring(0, 217) + '...';
    return summary;
}

function normalizeSearchDocumentation(documentation: string | null | undefined) : string | undefined
{
    if (!documentation)
        return undefined;
    let trimmed = documentation.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export {
    BuildConstructorArgumentIdentityType,
    BuildConstructorSymbolId,
    CanonicalizeConstructorArgumentType,
    CompareConstructorProjections,
    ExportAPIQueryMaterializedIndex,
    GetConstructorSymbolIdPrefix,
    GetAPIExactSymbols,
    GetAPIQuery,
    IsEligibleStructConstructor,
    IsCopyLikeConstructor,
    IsPublicStructConstructor,
    ProjectConstructor,
    ResolveConstructorOwnerType,
} from './api_query_engine';

export type {
    ApiConstructorArgument,
    ApiConstructorProjection,
    ApiQueryKind,
    ApiQueryMatch,
    ApiQuerySource,
    GetAPIExactSymbolsParams,
    GetAPIExactSymbolsResult,
    GetAPIQueryParams,
    GetAPIQueryResult,
} from './api_query_engine';

function createSearchTextVariant(value: string) : SearchTextVariant
{
    return {
        text: value,
        textLower: value.toLowerCase(),
        boundaries: collectSearchBoundaries(value)
    };
}

function dedupeSearchTextVariants(values: string[] | undefined, canonicalTextLower: string) : SearchTextVariant[]
{
    if (!values || values.length == 0)
        return [];

    let seen = new Set<string>([canonicalTextLower]);
    let result: SearchTextVariant[] = [];
    for (let value of values)
    {
        let trimmed = value.trim();
        if (trimmed.length == 0)
            continue;

        let normalized = trimmed.toLowerCase();
        if (seen.has(normalized))
            continue;

        seen.add(normalized);
        result.push(createSearchTextVariant(trimmed));
    }

    return result;
}

function getShortName(qualifiedName: string, kind: ApiSearchKind) : string
{
    let dotIndex = qualifiedName.lastIndexOf('.');
    if (dotIndex != -1 && (kind == 'method' || kind == 'property'))
        return qualifiedName.substring(dotIndex + 1);

    let namespaceIndex = qualifiedName.lastIndexOf('::');
    if (namespaceIndex != -1)
        return qualifiedName.substring(namespaceIndex + 2);

    return qualifiedName;
}

function collectSearchBoundaries(value: string) : SearchBoundary[]
{
    let boundaries: SearchBoundary[] = [];
    for (let index = 0; index < value.length; index += 1)
    {
        if (value[index] == ':' && value[index + 1] == ':')
        {
            boundaries.push({
                kind: 'namespace',
                start: index,
                end: index + 2
            });
            index += 1;
            continue;
        }

        if (value[index] == '.')
        {
            boundaries.push({
                kind: 'member',
                start: index,
                end: index + 1
            });
        }
    }
    return boundaries;
}

type ParsedRegex = {
    pattern: string;
    flags: string;
};

type SearchTextValue = {
    text: string;
    viewPriority: number;
};

function parseRegexPattern(raw: string) : ParsedRegex
{
    if (!(raw.length >= 2 && raw.startsWith('/') && raw.lastIndexOf('/') > 0))
        throw new Error("Expected /pattern/flags syntax.");

    let lastSlash = raw.lastIndexOf('/');
    return {
        pattern: raw.substring(1, lastSlash),
        flags: raw.substring(lastSlash + 1)
    };
}

function buildRegex(rawPattern: string) : RegExp
{
    try
    {
        let parsed = parseRegexPattern(rawPattern);
        if (parsed.flags && !/^[dgimsuvy]*$/.test(parsed.flags))
            throw new Error(`Invalid regex flags "${parsed.flags}".`);
        return new RegExp(parsed.pattern, parsed.flags);
    }
    catch (error)
    {
        let message = error instanceof Error ? error.message : String(error);
        throw new ApiSearchValidationError(`Invalid params. 'query' is not a valid regex. ${message}`);
    }
}

function getRegexSearchTextValues(entry: SearchIndexEntry) : SearchTextValue[]
{
    let result: SearchTextValue[] = [
        { text: entry.qualifiedName, viewPriority: 0 },
        { text: entry.shortName, viewPriority: 2 }
    ];

    for (let alias of entry.qualifiedAliasTexts)
        result.push({ text: alias.text, viewPriority: 1 });

    if (!isEntryCallable(entry))
        return dedupeSearchTextValues(result);

    result.push(
        { text: `${entry.qualifiedName}()`, viewPriority: 0 },
        { text: `${entry.shortName}()`, viewPriority: 2 }
    );
    for (let alias of entry.qualifiedAliasTexts)
        result.push({ text: `${alias.text}()`, viewPriority: 1 });

    return dedupeSearchTextValues(result);
}

function dedupeScopeCandidates(candidates: ScopeCandidate[]) : ScopeCandidate[]
{
    if (candidates.length <= 1)
        return candidates;

    let deduped: ScopeCandidate[] = [];
    let seen = new Set<string>();
    for (let candidate of candidates)
    {
        let key = `${candidate.kind}|${candidate.qualifiedName}`;
        if (seen.has(key))
            continue;

        seen.add(key);
        deduped.push(candidate);
    }

    return deduped;
}

function dedupeSearchTextValues(values: SearchTextValue[]) : SearchTextValue[]
{
    let seen = new Set<string>();
    let result: SearchTextValue[] = [];
    for (let value of values)
    {
        let normalized = value.text.toLowerCase();
        if (seen.has(normalized))
            continue;

        seen.add(normalized);
        result.push(value);
    }
    return result;
}

function findRegexSortKey(entry: SearchIndexEntry, regex: RegExp) : SearchMatchSortKey | null
{
    let bestSortKey: SearchMatchSortKey | null = null;
    for (let value of getRegexSearchTextValues(entry))
    {
        let match = regexExec(regex, value.text);
        if (!match)
            continue;

        let sortKey: SearchMatchSortKey = {
            reasonRank: 0,
            qualifiedPriorityEnabled: 0,
            exactQualifiedPriority: 0,
            qualifiedStart: Number.MAX_SAFE_INTEGER,
            qualifiedTotalGap: Number.MAX_SAFE_INTEGER,
            qualifiedSpan: Number.MAX_SAFE_INTEGER,
            start: match.index,
            totalGap: 0,
            span: match.length,
            viewPriority: value.viewPriority
        };
        bestSortKey = pickBetterSortKey(bestSortKey, sortKey);
    }
    return bestSortKey;
}

function pickBetterSortKey(left: SearchMatchSortKey | null, right: SearchMatchSortKey | null) : SearchMatchSortKey | null
{
    if (!left)
        return right;
    if (!right)
        return left;
    if (left.reasonRank != right.reasonRank)
        return left.reasonRank > right.reasonRank ? left : right;
    if (left.start != right.start)
        return left.start < right.start ? left : right;
    if (left.totalGap != right.totalGap)
        return left.totalGap < right.totalGap ? left : right;
    if (left.span != right.span)
        return left.span < right.span ? left : right;
    if (left.viewPriority != right.viewPriority)
        return left.viewPriority < right.viewPriority ? left : right;
    return left;
}

function regexExec(regex: RegExp, text: string) : { index: number; length: number } | null
{
    if (regex.global || regex.sticky)
        regex.lastIndex = 0;

    let match = regex.exec(text);
    if (!match)
        return null;

    return {
        index: match.index,
        length: match[0]?.length ?? 0
    };
}
