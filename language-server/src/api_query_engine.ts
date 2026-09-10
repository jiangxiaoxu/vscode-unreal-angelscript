import * as typedb from './database';
import { createHash } from 'node:crypto';
import {
    accessorPropertyAccess,
    unknownFunctionAccess,
    unknownPropertyAccess,
} from './accessContract';
import type { FunctionAccess, PropertyAccess } from './accessContract';
import { GetPropertyAccessorInfo } from './accessor_utils';

export type ApiSearchMode = 'smart' | 'regex';
export type ApiSearchSource = 'native' | 'script' | 'both';
export type ApiSearchMatchSource = 'native' | 'script';
export type ApiSearchKind = 'namespace' | 'class' | 'struct' | 'enum' | 'constructor' | 'method' | 'function' | 'property' | 'globalVariable';
export type ApiSearchVisibility = 'public' | 'protected' | 'private';
export type ApiSearchScopeKind = 'namespace' | 'class' | 'struct' | 'enum';
export type ApiSearchScopeRelationship = 'declared' | 'inherited' | 'mixin';
export type ApiSearchSymbolLevel = 'all' | 'type';
export type ApiSearchMatchedBy = 'self' | 'member' | 'mixin';

export type ApiSearchDocSource = {
    kind: 'nativeClass';
    name: string;
};

export type GetAPISearchParams = {
    query: string;
    mode?: ApiSearchMode;
    limit?: number;
    offset?: number;
    kinds?: ApiSearchKind[];
    source?: ApiSearchSource;
    scope?: string;
    declaredOnly?: boolean;
    includeInheritedFromScope?: boolean;
    includeDocs?: boolean;
    includePrivateOrProtectedMembers?: boolean;
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
    shortName: string;
    namespaceQualifiedName: string;
    kind: ApiSearchKind;
    signature: string;
    matchReason?: SearchMatchReason;
    summary?: string;
    documentation?: string;
    docSource?: ApiSearchDocSource;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    visibility: ApiSearchVisibility;
    access?: PropertyAccess | FunctionAccess;
    isCallable?: boolean;
    isAccessor?: true;
    isMixin?: boolean;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    scopeRelationship?: ApiSearchScopeRelationship;
    scopeDistance?: number;
    matchedBy?: ApiSearchMatchedBy;
    matchedByQualifiedName?: string;
    matchedByKind?: ApiSearchKind;
    detailsData?: unknown;
    ownerQualifiedName?: string;
    symbolId?: string;
    args?: ApiConstructorArgument[];
    requiredArgumentCount?: number;
};

export type ApiConstructorArgument = {
    type: string;
    name?: string;
    defaultValue?: string;
};

export type ConstructorDBArgMetadata = {
    constructorConst?: boolean;
    constructorModifier?: 'in' | 'out' | 'inout';
};

export type ApiConstructorProjection = {
    kind: 'constructor';
    name: string;
    qualifiedName: string;
    ownerQualifiedName: string;
    declaration: string;
    args: ApiConstructorArgument[];
    source: ApiSearchMatchSource;
    isCallable: true;
    symbolId: string;
    requiredArgumentCount: number;
    documentation?: string;
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
    includePrivateOrProtectedMembers: boolean;
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
    isAccessor: boolean;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    signature: string;
    summary?: string;
    documentation?: string;
    docSource?: ApiSearchDocSource;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    filterSource: ApiSearchSource;
    visibility: ApiSearchVisibility;
    access?: PropertyAccess | FunctionAccess;
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
    ownerQualifiedName?: string;
    symbolId?: string;
    args?: ApiConstructorArgument[];
    requiredArgumentCount?: number;
};

export type ApiQueryMaterializedEntry = {
    qualifiedName: string;
    shortName: string;
    namespaceQualifiedName: string;
    kind: ApiSearchKind;
    isCallable: boolean;
    isAccessor?: true;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    signature: string;
    summary?: string;
    documentation?: string;
    docSource?: ApiSearchDocSource;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    filterSource: ApiSearchSource;
    visibility: ApiSearchVisibility;
    access?: PropertyAccess | FunctionAccess;
    detailsData?: unknown;
    declaringTypeQualifiedName?: string;
    isMixin: boolean;
    mixinTargetQualifiedName?: string;
    qualifiedAliases: string[];
    overrideKey?: string;
    ownerQualifiedName?: string;
    symbolId?: string;
    args?: ApiConstructorArgument[];
    requiredArgumentCount?: number;
};

export type ApiQueryMaterializedScope = {
    kind: ApiSearchScopeKind;
    qualifiedName: string;
    shortName: string;
    isClassType: boolean;
    source: ApiSearchSource;
    directSuperQualifiedName?: string;
};

export type ApiQueryMaterializedIndex = {
    entries: ApiQueryMaterializedEntry[];
    scopes: ApiQueryMaterializedScope[];
};

type SearchIndex = {
    entries: SearchIndexEntry[];
    scopeCandidates: ScopeCandidate[];
    typeEntriesByQualifiedName: Map<string, SearchIndexEntry>;
    constructorSymbolIdPrefixesByOwner: Map<string, Map<string, string>>;
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
// Public CLI 仍限制 1000; cache adapter 需要完整排序结果以依次完成 public projection, 去重和 offset 分页.
const MAX_LIMIT = 1_000_000;
const DEFAULT_OFFSET = 0;
const QUERY_TOO_SHORT_THRESHOLD = 2;

const allKinds = new Set<ApiSearchKind>([
    'namespace',
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
    namespace: 0,
    class: 1,
    struct: 2,
    enum: 3,
    constructor: 4,
    method: 5,
    function: 6,
    property: 7,
    globalVariable: 8
};

const kindAliases = new Map<string, ApiSearchKind>([
    ['namespace', 'namespace'],
    ['class', 'class'],
    ['struct', 'struct'],
    ['enum', 'enum'],
    ['constructor', 'constructor'],
    ['method', 'method'],
    ['function', 'function'],
    ['property', 'property'],
    ['globalvariable', 'globalVariable']
]);

let cachedSearchIndex: SearchIndex | null = null;
let cachedDirtyTypeCacheId = -1;

function normalizeSearchText(value: string) : string
{
    return String(value ?? '').toLocaleLowerCase('und');
}

export function InvalidateAPISearchCache()
{
    cachedSearchIndex = null;
    cachedDirtyTypeCacheId = -1;
}

export function ResolveConstructorOwnerType(method: typedb.DBMethod) : typedb.DBType | null
{
    if (method.containingType)
        return method.containingType;

    if (method.namespace)
    {
        let shadowed = method.namespace.getShadowedType();
        if (shadowed)
            return shadowed;
    }

    if (method.returnType && method.returnType != 'void')
    {
        let lookupNamespace = method.namespace;
        if (lookupNamespace && lookupNamespace.isRootNamespace())
            lookupNamespace = null;
        let found = typedb.LookupType(lookupNamespace, method.returnType) ?? typedb.GetTypeByName(method.returnType);
        if (found)
            return found;
    }

    if (method.name && method.name != '$beh0')
        return typedb.GetTypeByName(method.name);

    return null;
}

export function CanonicalizeConstructorArgumentType(typeName: string) : string
{
    return String(typeName ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*&\s*(inout|in|out)\b/g, '&$1')
        .replace(/\s*&\s*/g, '&')
        .replace(/\s*@\s*/g, '@');
}

function constructorComparisonType(typeName: string) : string
{
    return CanonicalizeConstructorArgumentType(typeName)
        .replace(/^const\s+/, '')
        .replace(/\s+const$/, '')
        .replace(/(?:&(?:inout|in|out)?|@)$/, '')
        .trim();
}

export function IsCopyLikeConstructor(method: typedb.DBMethod, owner: typedb.DBType) : boolean
{
    if (!method.args || method.args.length != 1)
        return false;

    let argumentType = constructorComparisonType(method.args[0].typename);
    let ownerQualifiedName = constructorComparisonType(owner.getQualifiedTypenameInNamespace(null));
    let ownerShortName = constructorComparisonType(owner.name);
    let templateSubTypes = Array.isArray(owner.templateSubTypes) ? owner.templateSubTypes : [];
    let ownerTemplateName = templateSubTypes.length > 0
        ? constructorComparisonType(`${ownerQualifiedName}<${templateSubTypes.join(',')}>`)
        : '';
    let ownerShortTemplateName = templateSubTypes.length > 0
        ? constructorComparisonType(`${ownerShortName}<${templateSubTypes.join(',')}>`)
        : '';
    return argumentType == ownerQualifiedName
        || argumentType == ownerShortName
        || (!!ownerTemplateName && argumentType == ownerTemplateName)
        || (!!ownerShortTemplateName && argumentType == ownerShortTemplateName);
}

export function IsEligibleStructConstructor(method: typedb.DBMethod, ownerOverride?: typedb.DBType | null) : boolean
{
    if (!method.isConstructor)
        return false;
    let owner = ownerOverride ?? ResolveConstructorOwnerType(method);
    return !!owner
        && owner.isStruct
        && !owner.isDelegate
        && !owner.isEvent
        && !owner.isPrimitive
        && !owner.isEnum
        && !IsCopyLikeConstructor(method, owner);
}

function getSymbolVisibility(symbol: typedb.DBSymbol) : ApiSearchVisibility
{
    let visibleSymbol = symbol as typedb.DBSymbol & { isPrivate?: boolean; isProtected?: boolean };
    if (visibleSymbol.isPrivate === true)
        return 'private';
    if (visibleSymbol.isProtected === true)
        return 'protected';
    return 'public';
}

export function IsPublicStructConstructor(method: typedb.DBMethod, ownerOverride?: typedb.DBType | null) : boolean
{
    return IsEligibleStructConstructor(method, ownerOverride)
        && !method.isPrivate
        && !method.isProtected;
}

export function BuildConstructorSymbolId(
    source: ApiSearchMatchSource,
    ownerQualifiedName: string,
    argumentTypes: string[]
) : string
{
    let identity = JSON.stringify([
        'constructor',
        source,
        ownerQualifiedName,
        argumentTypes.map(CanonicalizeConstructorArgumentType)
    ]);
    return createHash('sha256').update(identity, 'utf8').digest('hex');
}

export function BuildConstructorArgumentIdentityType(arg: typedb.DBArg) : string
{
    let metadata = arg as typedb.DBArg & ConstructorDBArgMetadata;
    let identityType = CanonicalizeConstructorArgumentType(arg.typename);
    if (metadata.constructorConst === true && !identityType.startsWith('const '))
        identityType = `const ${identityType}`;
    if (metadata.constructorModifier && !new RegExp(`&${metadata.constructorModifier}$`).test(identityType))
    {
        identityType = identityType.replace(/&(?:inout|in|out)?$/, '');
        identityType += `&${metadata.constructorModifier}`;
    }
    return identityType;
}

export function ProjectConstructor(
    method: typedb.DBMethod,
    ownerOverride?: typedb.DBType | null
) : ApiConstructorProjection | null
{
    let owner = ownerOverride ?? ResolveConstructorOwnerType(method);
    if (!owner || !IsEligibleStructConstructor(method, owner))
        return null;

    let ownerQualifiedName = owner.getQualifiedTypenameInNamespace(null);
    let args = (method.args ?? []).map((arg) : ApiConstructorArgument => ({
        type: BuildConstructorArgumentIdentityType(arg),
        ...(arg.name ? { name: arg.name } : {}),
        ...(arg.defaultvalue != null ? { defaultValue: arg.defaultvalue } : {})
    }));
    let argumentDeclaration = args.map((arg) => {
        let declaration = arg.type;
        if (arg.name)
            declaration += ` ${arg.name}`;
        if (arg.defaultValue !== undefined)
            declaration += ` = ${arg.defaultValue}`;
        return declaration;
    }).join(', ');
    let source = getDeclaredSource(method.declaredModule);
    let documentation = normalizeSearchDocumentation(method.findAvailableDocumentation());

    return {
        kind: 'constructor',
        name: owner.name,
        qualifiedName: `${ownerQualifiedName}.${owner.name}`,
        ownerQualifiedName,
        declaration: `${owner.name}(${argumentDeclaration})`,
        args,
        source,
        isCallable: true,
        symbolId: BuildConstructorSymbolId(source, ownerQualifiedName, (method.args ?? []).map(BuildConstructorArgumentIdentityType)),
        requiredArgumentCount: method.getRequiredArgumentCount(),
        ...(documentation ? { documentation } : {})
    };
}

export function CompareConstructorProjections(
    left: ApiConstructorProjection,
    right: ApiConstructorProjection
) : number
{
    if (left.requiredArgumentCount != right.requiredArgumentCount)
        return left.requiredArgumentCount - right.requiredArgumentCount;
    if (left.args.length != right.args.length)
        return left.args.length - right.args.length;
    let leftArgumentTypes = left.args.map((arg) => CanonicalizeConstructorArgumentType(arg.type)).join('\u0000');
    let rightArgumentTypes = right.args.map((arg) => CanonicalizeConstructorArgumentType(arg.type)).join('\u0000');
    let argumentTypeOrder = leftArgumentTypes.localeCompare(rightArgumentTypes);
    if (argumentTypeOrder != 0)
        return argumentTypeOrder;
    return left.symbolId.localeCompare(right.symbolId);
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

export type ApiQuerySource = ApiSearchSource;
export type ApiQueryKind = ApiSearchKind;

export type GetAPIQueryParams = {
    query: string;
    mode?: ApiSearchMode;
    source?: ApiQuerySource;
    kinds?: ApiQueryKind[];
    scope?: string;
    declaredOnly?: boolean;
    excludeInherited?: boolean;
    includeDocs?: boolean;
    includeNonPublic?: boolean;
    symbolLevel?: ApiSearchSymbolLevel;
    limit?: number;
    offset?: number;
};

type ApiQueryScopeMode = 'default' | 'exclude-inherited' | 'declared-only';

export type ApiQueryMatch = Omit<GetAPISearchMatch, 'kind' | 'source'> & {
    kind: ApiQueryKind;
    source: ApiQuerySource;
    symbolIdPrefix?: string;
};

type CoreRankedMatch = {
    candidate: SearchCandidate;
    match: ApiQueryMatch;
};

type CoreScopeGroup = {
    scope: GetAPISearchResolvedScope;
    matches: CoreRankedMatch[];
};

type OwnerSeededItem<T> = {
    groupIndex: number;
    item: T;
};

export type GetAPIQueryResult = {
    ok: true;
    data: {
        query: string;
        mode: ApiSearchMode;
        matches: ApiQueryMatch[];
        total: number;
        returned: number;
        limit: number;
        offset: number;
        omitted: number;
        truncated: boolean;
        notices?: GetAPISearchNotice[];
        scopeLookup?: GetAPISearchScopeLookup;
        scopeGroups?: Array<{
            scope: GetAPISearchResolvedScope;
            matches: ApiQueryMatch[];
            totalMatches: number;
            omittedMatches: number;
        }>;
        inheritedScopeOutcome?: ApiInheritedScopeOutcome;
    };
};

export type GetAPIExactSymbolsParams = {
    name: string;
    kind?: ApiQueryKind;
    source?: ApiQuerySource;
    includeDocs?: boolean;
    includeNonPublic?: boolean;
    symbolId?: string;
};

export type GetAPIExactSymbolsResult = {
    ok: true;
    data: {
        requestedName: string;
        found: boolean;
        symbols: ApiQueryMatch[];
    };
} | {
    ok: false;
    error: {
        code: 'InvalidParams' | 'NotFound';
        message: string;
    };
};

function normalizeCoreBoolean(value: unknown, name: string, defaultValue = false) : boolean
{
    if (value === undefined)
        return defaultValue;
    if (typeof value !== 'boolean')
        throw new ApiSearchValidationError(`Invalid params. '${name}' must be a boolean.`);
    return value;
}

function normalizeCoreScopeMode(record: Record<string, unknown>, scope: string) : ApiQueryScopeMode
{
    let hasDeclaredOnly = Object.prototype.hasOwnProperty.call(record, 'declaredOnly');
    let hasExcludeInherited = Object.prototype.hasOwnProperty.call(record, 'excludeInherited');
    let declaredOnly = normalizeCoreBoolean(record.declaredOnly, 'declaredOnly');
    let excludeInherited = normalizeCoreBoolean(record.excludeInherited, 'excludeInherited');

    if (hasDeclaredOnly && hasExcludeInherited)
        throw new ApiSearchValidationError("Invalid params. 'declaredOnly' and 'excludeInherited' cannot be combined.");
    if ((hasDeclaredOnly || hasExcludeInherited) && !scope)
        throw new ApiSearchValidationError("Invalid params. 'declaredOnly' and 'excludeInherited' require 'scope'.");
    if (declaredOnly)
        return 'declared-only';
    if (excludeInherited)
        return 'exclude-inherited';
    return 'default';
}

function normalizeCoreKinds(value: unknown) : ApiQueryKind[] | undefined
{
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length == 0)
        throw new ApiSearchValidationError("Invalid params. 'kinds' must be a non-empty array.");
    let result = new Array<ApiQueryKind>();
    for (let item of value)
    {
        if (typeof item !== 'string')
            throw new ApiSearchValidationError("Invalid params. 'kinds' entries must be strings.");
        let kind = kindAliases.get(item.trim().toLowerCase());
        if (!kind)
            throw new ApiSearchValidationError(`Invalid params. Unsupported kind "${item}".`);
        if (!result.includes(kind))
            result.push(kind);
    }
    return result;
}

function rawKindsForCoreKinds(kinds: ApiQueryKind[] | undefined) : ApiSearchKind[] | undefined
{
    if (!kinds)
        return undefined;
    let raw = new Set<ApiSearchKind>();
    for (let kind of kinds)
    {
        raw.add(kind);
        if (kind == 'property')
        {
            raw.add('method');
            raw.add('function');
        }
    }
    return [...raw];
}

function getCorePresentationKind(match: GetAPISearchMatch) : ApiQueryKind
{
    if ((match.kind == 'method' || match.kind == 'function') && match.isAccessor === true)
        return 'property';
    return match.kind;
}

function getCoreNamespaceSource(match: GetAPISearchMatch) : ApiQuerySource
{
    if (match.kind != 'namespace')
        return match.source;
    let namespace = typedb.LookupNamespace(null, match.qualifiedName);
    if (!namespace)
        return match.source;
    return getNamespaceSource(namespace).filterSource;
}

function projectCoreMatch(match: GetAPISearchMatch) : ApiQueryMatch
{
    return {
        ...match,
        kind: getCorePresentationKind(match),
        source: getCoreNamespaceSource(match)
    };
}

function stableRecordIdentity(value: unknown) : string
{
    if (Array.isArray(value))
        return `[${value.map(stableRecordIdentity).join(',')}]`;
    if (value && typeof value == 'object')
    {
        let record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableRecordIdentity(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function dedupeCoreMatches(matches: ApiQueryMatch[]) : ApiQueryMatch[]
{
    let seen = new Set<string>();
    let result = new Array<ApiQueryMatch>();
    for (let match of matches)
    {
        let identity = stableRecordIdentity(match);
        if (seen.has(identity))
            continue;
        seen.add(identity);
        result.push(match);
    }
    return result;
}

function filterCoreScopeMode(matches: ApiQueryMatch[], mode: ApiQueryScopeMode) : ApiQueryMatch[]
{
    return matches.filter((match) => matchesCoreScopeMode(match, mode));
}

function matchesCoreScopeMode(match: ApiQueryMatch, mode: ApiQueryScopeMode) : boolean
{
    if (mode == 'declared-only')
        return match.scopeRelationship == 'declared';
    if (mode == 'exclude-inherited')
        return match.scopeRelationship != 'inherited';
    return true;
}

function buildMergedCoreScopeGroups(
    payload: GetAPISearchParams,
    kinds: ApiQueryKind[] | undefined,
    scopeMode: ApiQueryScopeMode
) : CoreScopeGroup[] | undefined
{
    let params = normalizeSearchParams(payload);
    if (!params.scope)
        return undefined;

    let index = getSearchIndex();
    let scopeResolution = resolveScope(index, params.scope, params.includeInheritedFromScopeMode);
    if (!scopeResolution.hasMergedSameNameScope)
        return undefined;
    if (params.mode == 'smart' && params.smartQueries && params.smartQueries.every((query) => isTinySmartQuery(query)))
    {
        return scopeResolution.scopes.map((scope) => ({
            scope: buildResolvedScopeInfo(scope),
            matches: new Array<CoreRankedMatch>()
        }));
    }

    let baseCandidates = index.entries.map((entry) : SearchCandidate => ({ entry }));
    let rankedScopeGroups = buildRankedScopeGroups(
        baseCandidates,
        scopeResolution.scopes,
        scopeResolution.notices,
        params,
        index
    );
    return rankedScopeGroups.map((group) =>
    {
        let seen = new Set<string>();
        let matches = new Array<CoreRankedMatch>();
        for (let candidate of group.candidates)
        {
            let match = projectCoreMatch(buildMatch(candidate, params.includeDocs));
            if ((kinds && !kinds.includes(match.kind)) || !matchesCoreScopeMode(match, scopeMode))
                continue;
            let identity = stableRecordIdentity(match);
            if (seen.has(identity))
                continue;
            seen.add(identity);
            matches.push({ candidate, match });
        }
        return {
            scope: buildResolvedScopeInfo(group.scope),
            matches
        };
    });
}

function dedupeOwnerSeededCoreMatches(matches: OwnerSeededItem<CoreRankedMatch>[]) : OwnerSeededItem<CoreRankedMatch>[]
{
    let seen = new Set<string>();
    return matches.filter((selected) =>
    {
        let identity = stableRecordIdentity(selected.item.match);
        if (seen.has(identity))
            return false;
        seen.add(identity);
        return true;
    });
}

export function GetAPIQuery(payload: unknown) : GetAPIQueryResult
{
    if (!payload || typeof payload != 'object' || Array.isArray(payload))
        throw new ApiSearchValidationError("Invalid params. Provide a structured API query object.");
    let record = payload as Record<string, unknown>;
    let query = typeof record.query == 'string' ? record.query.trim() : '';
    if (!query)
        throw new ApiSearchValidationError("Invalid params. 'query' must be a non-empty string.");
    let mode = normalizeSearchMode(record.mode);
    let source = normalizeSource(record.source);
    let kinds = normalizeCoreKinds(record.kinds);
    let symbolLevel = normalizeSymbolLevel(record.symbolLevel);
    if (symbolLevel == 'type' && kinds && kinds.some((kind) => !typeOnlyKinds.has(kind as ApiSearchTypeKind)))
        throw new ApiSearchValidationError("Invalid params. 'kinds' only supports class, struct, or enum when 'symbolLevel' is 'type'.");
    let scope = typeof record.scope == 'string' ? record.scope.trim() : '';
    if (record.scope !== undefined && typeof record.scope != 'string')
        throw new ApiSearchValidationError("Invalid params. 'scope' must be a string.");
    let scopeMode = normalizeCoreScopeMode(record, scope);
    let includeDocs = normalizeCoreBoolean(record.includeDocs, 'includeDocs');
    let includeNonPublic = normalizeCoreBoolean(record.includeNonPublic, 'includeNonPublic');
    let limit = record.limit === undefined ? 20 : normalizeLimit(record.limit);
    if (limit > 1000)
        throw new ApiSearchValidationError("Invalid params. 'limit' must be between 1 and 1000.");
    let offset = normalizeOffset(record.offset);
    let rawPayload: GetAPISearchParams = {
        query,
        mode,
        source,
        kinds: rawKindsForCoreKinds(kinds),
        ...(scope ? { scope } : {}),
        declaredOnly: scopeMode != 'default',
        includeDocs,
        includePrivateOrProtectedMembers: includeNonPublic,
        symbolLevel,
        limit: MAX_LIMIT,
        offset: 0
    };
    let raw = GetAPISearch(rawPayload);
    let mergedScopeGroups = raw.scopeGroups
        ? buildMergedCoreScopeGroups(rawPayload, kinds, scopeMode)
        : undefined;
    let orderedMergedMatches = mergedScopeGroups
        ? orderOwnerSeededGroups(
            mergedScopeGroups.map((group) => group.matches),
            (left, right) => compareCandidates(left.candidate, right.candidate)
        )
        : undefined;
    let orderedMergedUniqueMatches = orderedMergedMatches
        ? dedupeOwnerSeededCoreMatches(orderedMergedMatches)
        : undefined;
    let allMatches = orderedMergedUniqueMatches
        ? orderedMergedUniqueMatches.map((selected) => selected.item.match)
        : filterCoreScopeMode(dedupeCoreMatches(raw.matches
            .map(projectCoreMatch)
            .filter((match) => !kinds || kinds.includes(match.kind))), scopeMode);
    allMatches = addConstructorSymbolIdPrefixes(allMatches);
    let pageMatches = allMatches.slice(offset, offset + limit);
    let pageSelections = orderedMergedUniqueMatches?.slice(offset, offset + limit);
    let scopeGroups = mergedScopeGroups?.map((group, groupIndex) =>
    {
        let groupMatches = orderedMergedUniqueMatches?.filter((selected) => selected.groupIndex == groupIndex) ?? [];
        let groupPage = pageSelections
            ?.filter((selected) => selected.groupIndex == groupIndex)
            .map((selected) => addConstructorSymbolIdPrefix(selected.item.match)) ?? [];
        return {
            scope: group.scope,
            matches: groupPage,
            totalMatches: groupMatches.length,
            omittedMatches: Math.max(0, groupMatches.length - groupPage.length)
        };
    });
    return {
        ok: true,
        data: {
            query,
            mode,
            matches: pageMatches,
            total: allMatches.length,
            returned: pageMatches.length,
            limit,
            offset,
            omitted: Math.max(0, allMatches.length - pageMatches.length),
            truncated: offset + pageMatches.length < allMatches.length,
            ...(raw.notices ? { notices: raw.notices } : {}),
            ...(raw.scopeLookup ? { scopeLookup: raw.scopeLookup } : {}),
            ...(scopeGroups ? { scopeGroups } : {}),
            ...(raw.inheritedScopeOutcome ? { inheritedScopeOutcome: raw.inheritedScopeOutcome } : {})
        }
    };
}

function finalCoreNameSegment(name: string) : string
{
    let namespaceIndex = name.lastIndexOf('::');
    let memberIndex = name.lastIndexOf('.');
    if (namespaceIndex > memberIndex)
        return name.substring(namespaceIndex + 2);
    if (memberIndex >= 0)
        return name.substring(memberIndex + 1);
    return name;
}

function isQualifiedCoreName(name: string) : boolean
{
    return name.includes('::') || name.includes('.');
}

function getConstructorFamilyOwner(name: string) : string | null
{
    let dot = name.lastIndexOf('.');
    if (dot <= 0 || dot == name.length - 1)
        return null;
    let owner = name.substring(0, dot);
    return finalCoreNameSegment(owner) == name.substring(dot + 1) ? owner : null;
}

function compareExactMatches(left: ApiQueryMatch, right: ApiQueryMatch) : number
{
    if (left.kind == 'constructor' && right.kind == 'constructor')
    {
        let required = (left.requiredArgumentCount ?? 0) - (right.requiredArgumentCount ?? 0);
        if (required != 0)
            return required;
        let count = (left.args?.length ?? 0) - (right.args?.length ?? 0);
        if (count != 0)
            return count;
        let leftTypes = (left.args ?? []).map((arg) => CanonicalizeConstructorArgumentType(arg.type)).join('\u0000');
        let rightTypes = (right.args ?? []).map((arg) => CanonicalizeConstructorArgumentType(arg.type)).join('\u0000');
        let types = leftTypes.localeCompare(rightTypes);
        if (types != 0)
            return types;
        return String(left.symbolId ?? '').localeCompare(String(right.symbolId ?? ''));
    }
    return `${left.qualifiedName}\u0000${left.source}\u0000${left.kind}\u0000${left.signature}`
        .localeCompare(`${right.qualifiedName}\u0000${right.source}\u0000${right.kind}\u0000${right.signature}`);
}

function getShortestUniqueConstructorSymbolIdPrefix(
    symbolId: string,
    familySymbolIds: readonly string[]
) : string | undefined
{
    let normalizedId = symbolId.toLowerCase();
    let normalizedFamilyIds = familySymbolIds.map((candidate) => candidate.toLowerCase());
    for (let length = 8; length <= normalizedId.length; ++length)
    {
        let prefix = normalizedId.substring(0, length);
        if (normalizedFamilyIds.filter((candidate) => candidate.startsWith(prefix)).length == 1)
            return prefix;
    }
    return undefined;
}

export function GetConstructorSymbolIdPrefix(ownerQualifiedName: string, symbolId: string) : string | undefined
{
    return getSearchIndex().constructorSymbolIdPrefixesByOwner
        .get(ownerQualifiedName)
        ?.get(symbolId.toLowerCase());
}

function addConstructorSymbolIdPrefix(match: ApiQueryMatch) : ApiQueryMatch
{
    if (match.kind != 'constructor' || !match.ownerQualifiedName || !match.symbolId)
        return match;
    let symbolIdPrefix = GetConstructorSymbolIdPrefix(match.ownerQualifiedName, match.symbolId);
    return symbolIdPrefix ? { ...match, symbolIdPrefix } : match;
}

function addConstructorSymbolIdPrefixes(matches: ApiQueryMatch[]) : ApiQueryMatch[]
{
    return matches.map(addConstructorSymbolIdPrefix);
}

function dedupeConstructorMatchesBySymbolId(matches: ApiQueryMatch[]) : ApiQueryMatch[]
{
    let canonicalBySymbolId = new Map<string, ApiQueryMatch>();
    let withoutSymbolId = new Array<ApiQueryMatch>();
    for (let match of matches)
    {
        if (match.kind != 'constructor' || !match.symbolId)
        {
            withoutSymbolId.push(match);
            continue;
        }
        let symbolId = match.symbolId.toLowerCase();
        let current = canonicalBySymbolId.get(symbolId);
        if (!current || stableRecordIdentity(match).localeCompare(stableRecordIdentity(current)) < 0)
            canonicalBySymbolId.set(symbolId, match);
    }
    return [...canonicalBySymbolId.values(), ...withoutSymbolId];
}

export function GetAPIExactSymbols(payload: unknown) : GetAPIExactSymbolsResult
{
    if (!payload || typeof payload != 'object' || Array.isArray(payload))
        return { ok: false, error: { code: 'InvalidParams', message: 'Invalid params. Provide an exact symbol query object.' } };
    let record = payload as Record<string, unknown>;
    let name = typeof record.name == 'string' ? record.name.trim() : '';
    if (!name)
        return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. 'name' must be a non-empty string." } };
    try
    {
        let kindList = record.kind === undefined ? undefined : normalizeCoreKinds([record.kind]);
        let kind = kindList?.[0];
        let source = normalizeSource(record.source);
        let includeDocs = normalizeCoreBoolean(record.includeDocs, 'includeDocs');
        let includeNonPublic = normalizeCoreBoolean(record.includeNonPublic, 'includeNonPublic');
        let hasSymbolId = record.symbolId !== undefined;
        if (hasSymbolId && typeof record.symbolId != 'string')
            return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. 'symbolId' must be a string." } };
        let symbolId = hasSymbolId ? (record.symbolId as string).trim().toLowerCase() : '';
        let constructorOwner = getConstructorFamilyOwner(name);
        if (kind == 'constructor' && !constructorOwner)
            return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. kind 'constructor' requires an exact Type.Type constructor family." } };
        if (hasSymbolId && !constructorOwner)
            return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. 'symbolId' may only be used with an exact Type.Type constructor family." } };
        if (hasSymbolId && kind && kind != 'constructor')
            return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. 'symbolId' cannot be combined with a non-constructor kind." } };
        if (hasSymbolId && !/^[0-9a-f]{8,64}$/.test(symbolId))
            return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. 'symbolId' must be an 8-64 character SHA-256 hex prefix." } };

        let queryParams: GetAPIQueryParams = {
            query: name,
            mode: 'smart',
            source: hasSymbolId ? 'both' : source,
            ...(kind ? { kinds: [kind] } : constructorOwner ? { kinds: ['constructor'] } : {}),
            includeDocs,
            includeNonPublic: hasSymbolId ? true : includeNonPublic,
        };
        let query = GetAPIQuery({ ...queryParams, limit: 1000, offset: 0 });
        let candidates = [...query.data.matches];
        while (constructorOwner && candidates.length < query.data.total)
        {
            let page = GetAPIQuery({ ...queryParams, limit: 1000, offset: candidates.length });
            if (page.data.matches.length == 0)
                break;
            candidates.push(...page.data.matches);
        }
        let exactQualified = candidates.filter((match) => match.qualifiedName == name);
        let matches = exactQualified.length > 0 || isQualifiedCoreName(name)
            ? exactQualified
            : candidates.filter((match) => finalCoreNameSegment(match.qualifiedName) == name);
        if (constructorOwner)
            matches = dedupeConstructorMatchesBySymbolId(dedupeCoreMatches(matches));
        else
            matches = dedupeCoreMatches(matches);
        matches = matches.sort(compareExactMatches);
        if (constructorOwner)
            matches = addConstructorSymbolIdPrefixes(matches);
        if (hasSymbolId)
        {
            matches = matches.filter((match) => match.symbolId?.toLowerCase().startsWith(symbolId));
            if (matches.length > 1)
            {
                return {
                    ok: false,
                    error: {
                        code: 'InvalidParams',
                        message: `Constructor symbol ID prefix is ambiguous for ${name}; provide a longer prefix.`
                    }
                };
            }
        }
        if (matches.length == 0)
            return { ok: false, error: { code: 'NotFound', message: `API symbol not found: ${name}` } };
        return { ok: true, data: { requestedName: name, found: true, symbols: matches } };
    }
    catch (error)
    {
        return {
            ok: false,
            error: {
                code: 'InvalidParams',
                message: error instanceof Error ? error.message : String(error)
            }
        };
    }
}

function normalizeSearchParams(payload: unknown) : NormalizedSearchParams
{
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new ApiSearchValidationError("Invalid params. Provide { query: string, mode?: 'smart' | 'regex', limit?: number, kinds?: ApiSearchKind[], source?: 'native' | 'script' | 'both', scope?: string, declaredOnly?: boolean, includeDocs?: boolean, includePrivateOrProtectedMembers?: boolean, symbolLevel?: 'all' | 'type' }.");

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
    if (record.includePrivateOrProtectedMembers !== undefined && typeof record.includePrivateOrProtectedMembers !== 'boolean')
        throw new ApiSearchValidationError("Invalid params. 'includePrivateOrProtectedMembers' must be a boolean.");
    let includePrivateOrProtectedMembers = record.includePrivateOrProtectedMembers === true;
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
        includePrivateOrProtectedMembers,
        symbolLevel,
        ...(kinds.typeResultKinds ? { typeResultKinds: kinds.typeResultKinds } : {}),
        ...(smartQueries ? { smartQueries } : {})
    };
}

function normalizeScopeInheritanceMode(record: Record<string, unknown>) : ScopeInheritanceMode
{
    if (Object.prototype.hasOwnProperty.call(record, 'includeInheritedFromScope'))
    {
        if (typeof record.includeInheritedFromScope !== 'boolean')
            throw new ApiSearchValidationError("Invalid params. 'includeInheritedFromScope' must be a boolean.");
        if (Object.prototype.hasOwnProperty.call(record, 'declaredOnly'))
            throw new ApiSearchValidationError("Invalid params. 'declaredOnly' and 'includeInheritedFromScope' cannot be combined.");
        return record.includeInheritedFromScope === true ? 'on' : 'off';
    }
    if (!Object.prototype.hasOwnProperty.call(record, 'declaredOnly'))
        return 'auto';
    if (typeof record.declaredOnly !== 'boolean')
        throw new ApiSearchValidationError("Invalid params. 'declaredOnly' must be a boolean.");
    return record.declaredOnly === true ? 'off' : 'auto';
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
            let kind = kindAliases.get(normalized);
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
        let kind = kindAliases.get(normalized);
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

export function ExportAPIQueryMaterializedIndex() : ApiQueryMaterializedIndex
{
    let index = getSearchIndex();
    let entries = index.entries.map((entry) : ApiQueryMaterializedEntry => ({
        qualifiedName: entry.qualifiedName,
        shortName: entry.shortName,
        namespaceQualifiedName: entry.namespaceQualifiedName,
        kind: entry.kind,
        isCallable: entry.isCallable,
        ...(entry.isAccessor ? { isAccessor: true } : {}),
        ...(entry.canBlueprintOverride ? { canBlueprintOverride: true } : {}),
        ...(entry.blueprintEventKind ? { blueprintEventKind: entry.blueprintEventKind } : {}),
        signature: entry.signature,
        ...(entry.summary ? { summary: entry.summary } : {}),
        ...(entry.documentation ? { documentation: entry.documentation } : {}),
        ...(entry.docSource ? { docSource: entry.docSource } : {}),
        ...(entry.containerQualifiedName ? { containerQualifiedName: entry.containerQualifiedName } : {}),
        source: entry.source,
        filterSource: entry.filterSource,
        visibility: entry.visibility,
        ...(entry.access !== undefined ? { access: entry.access } : {}),
        ...(entry.detailsData !== undefined ? { detailsData: entry.detailsData } : {}),
        ...(entry.declaringTypeQualifiedName ? { declaringTypeQualifiedName: entry.declaringTypeQualifiedName } : {}),
        isMixin: entry.isMixin,
        ...(entry.mixinTargetQualifiedName ? { mixinTargetQualifiedName: entry.mixinTargetQualifiedName } : {}),
        qualifiedAliases: entry.qualifiedAliasTexts.map((alias) => alias.text),
        ...(entry.overrideKey ? { overrideKey: entry.overrideKey } : {}),
        ...(entry.ownerQualifiedName ? { ownerQualifiedName: entry.ownerQualifiedName } : {}),
        ...(entry.symbolId ? { symbolId: entry.symbolId } : {}),
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.requiredArgumentCount !== undefined ? { requiredArgumentCount: entry.requiredArgumentCount } : {}),
    }));
    let entryByQualifiedName = new Map(entries.map((entry) => [entry.qualifiedName, entry]));
    let scopes = index.scopeCandidates.map((scope) : ApiQueryMaterializedScope => {
        let entry = entryByQualifiedName.get(scope.qualifiedName);
        let directSuper = scope.dbType ? resolveDirectSuperType(scope.dbType) : null;
        return {
            kind: scope.kind,
            qualifiedName: scope.qualifiedName,
            shortName: scope.shortName,
            isClassType: scope.isClassType,
            source: entry?.filterSource ?? 'both',
            ...(directSuper ? { directSuperQualifiedName: directSuper.getQualifiedTypenameInNamespace(null) } : {}),
        };
    });
    return { entries, scopes };
}

function buildSearchIndex() : SearchIndex
{
    let entries: SearchIndexEntry[] = [];
    let scopeCandidates: ScopeCandidate[] = [];
    let typeEntriesByQualifiedName = new Map<string, SearchIndexEntry>();

    let visitNamespace = function (namespace: typedb.DBNamespace)
    {
        if (!namespace.isRootNamespace() && !isInternalApiSymbolName(namespace.name) && !isNamespaceApiEmpty(namespace))
        {
            let qualifiedNamespace = namespace.getQualifiedNamespace();
            scopeCandidates.push({
                kind: 'namespace',
                qualifiedName: qualifiedNamespace,
                shortName: namespace.name,
                namespace,
                isClassType: false
            });
            entries.push(createNamespaceEntry(namespace, qualifiedNamespace));
        }

        for (let [_, childNamespace] of namespace.childNamespaces)
            visitNamespace(childNamespace);

        namespace.forEachSymbol((symbol) =>
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (!symbol.isConstructor && isInternalApiSymbolName(symbol.name))
                    return;
                if (shouldSkipMethod(symbol))
                    return;
                entries.push(createMethodEntry(symbol));
                return;
            }

            if (symbol instanceof typedb.DBProperty)
            {
                if (isInternalApiSymbolName(symbol.name))
                    return;
                entries.push(createGlobalPropertyEntry(symbol));
                return;
            }

            if (symbol instanceof typedb.DBType)
                visitType(symbol);
        });
    };

    let visitType = function (dbType: typedb.DBType)
    {
        if (!shouldIncludeTypeInSearch(dbType))
            return;

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

        dbType.forEachSymbol((symbol) =>
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (!symbol.isConstructor && isInternalApiSymbolName(symbol.name))
                    return;
                if (shouldSkipMethod(symbol))
                    return;
                entries.push(createMethodEntry(symbol));
                return;
            }

            if (symbol instanceof typedb.DBProperty)
            {
                if (isInternalApiSymbolName(symbol.name))
                    return;
                entries.push(createTypePropertyEntry(symbol));
            }
        }, false);
    };

    visitNamespace(typedb.GetRootNamespace());
    return {
        entries,
        scopeCandidates,
        typeEntriesByQualifiedName,
        constructorSymbolIdPrefixesByOwner: buildConstructorSymbolIdPrefixes(entries)
    };
}

function buildConstructorSymbolIdPrefixes(entries: readonly SearchIndexEntry[]) : Map<string, Map<string, string>>
{
    let symbolIdsByOwner = new Map<string, Set<string>>();
    for (let entry of entries)
    {
        if (entry.kind != 'constructor' || !entry.ownerQualifiedName || !entry.symbolId)
            continue;
        let symbolIds = symbolIdsByOwner.get(entry.ownerQualifiedName);
        if (!symbolIds)
        {
            symbolIds = new Set<string>();
            symbolIdsByOwner.set(entry.ownerQualifiedName, symbolIds);
        }
        symbolIds.add(entry.symbolId.toLowerCase());
    }

    let prefixesByOwner = new Map<string, Map<string, string>>();
    for (let [ownerQualifiedName, symbolIdSet] of symbolIdsByOwner)
    {
        let symbolIds = [...symbolIdSet];
        let prefixes = new Map<string, string>();
        for (let symbolId of symbolIds)
        {
            let prefix = getShortestUniqueConstructorSymbolIdPrefix(symbolId, symbolIds);
            if (prefix)
                prefixes.set(symbolId, prefix);
        }
        prefixesByOwner.set(ownerQualifiedName, prefixes);
    }
    return prefixesByOwner;
}

function createNamespaceEntry(namespace: typedb.DBNamespace, qualifiedNamespace: string) : SearchIndexEntry
{
    let documentation = normalizeSearchDocumentation(namespace.documentation);
    let docSource = (namespace as typedb.DBNamespace & { docSource?: ApiSearchDocSource }).docSource;
    let namespaceSource = getNamespaceSource(namespace);
    return createSearchEntry({
        qualifiedName: qualifiedNamespace,
        kind: 'namespace',
        isCallable: false,
        signature: `namespace ${qualifiedNamespace}`,
        summary: extractSummary(documentation),
        documentation,
        docSource,
        source: namespaceSource.source,
        filterSource: namespaceSource.filterSource,
        detailsData: ['namespace', qualifiedNamespace],
        namespaceQualifiedName: qualifiedNamespace
    });
}

function isNativeBlueprintOverrideTarget(method: typedb.DBMethod) : boolean
{
    return method.containingType != null && method.declaredModule == null && method.isBlueprintEvent;
}

function createMethodEntry(method: typedb.DBMethod) : SearchIndexEntry
{
    if (method.isConstructor)
        return createConstructorEntry(method);

    let documentation = normalizeSearchDocumentation(method.findAvailableDocumentation());
    let methodArgs = method.args ? method.args.map((arg) => arg.typename) : [];
    let isCallable = method.isCallable !== false;
    let isAccessor = method.isProperty === true;
    let accessor = isAccessor ? GetPropertyAccessorInfo(method) : null;
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
        aliasQualifiedNames = buildScopedMemberAliases(declaringTypeQualifiedName, method.name);
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
        isAccessor,
        access: isAccessor
            ? (accessor ? accessorPropertyAccess(method.access, accessor.kind) : unknownPropertyAccess())
            : method.access ?? unknownFunctionAccess(),
        ...(isNativeBlueprintOverrideTarget(method) ? { canBlueprintOverride: true } : {}),
        ...(blueprintEventKind !== undefined ? { blueprintEventKind } : {}),
        signature: buildMethodSignature(method),
        summary: extractSummary(documentation),
        documentation,
        containerQualifiedName,
        source: getDeclaredSource(method.declaredModule),
        filterSource: getDeclaredSource(method.declaredModule),
        visibility: getSymbolVisibility(method),
        detailsData,
        namespaceQualifiedName,
        declaringTypeQualifiedName,
        isMixin: method.isMixin,
        mixinTargetQualifiedName,
        aliasQualifiedNames,
        overrideKey: buildMethodOverrideKey(method)
    });
}

function createConstructorEntry(method: typedb.DBMethod) : SearchIndexEntry
{
    let constructor = ProjectConstructor(method);
    if (!constructor)
        throw new Error('Attempted to index an ineligible constructor.');

    let owner = ResolveConstructorOwnerType(method);
    let namespaceQualifiedName = owner?.namespace && !owner.namespace.isRootNamespace()
        ? owner.namespace.getQualifiedNamespace()
        : '';
    return createSearchEntry({
        qualifiedName: constructor.qualifiedName,
        kind: 'constructor',
        isCallable: true,
        signature: constructor.declaration,
        summary: extractSummary(constructor.documentation),
        documentation: constructor.documentation,
        containerQualifiedName: constructor.ownerQualifiedName,
        source: constructor.source,
        filterSource: constructor.source,
        visibility: getSymbolVisibility(method),
        detailsData: [
            'constructor',
            constructor.name,
            namespaceQualifiedName,
            constructor.symbolId,
            constructor.args.map((arg) => arg.type)
        ],
        namespaceQualifiedName,
        declaringTypeQualifiedName: constructor.ownerQualifiedName,
        ownerQualifiedName: constructor.ownerQualifiedName,
        symbolId: constructor.symbolId,
        args: constructor.args,
        requiredArgumentCount: constructor.requiredArgumentCount
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
        visibility: getSymbolVisibility(property),
        detailsData: ['property', property.containingType.name, property.name],
        namespaceQualifiedName,
        declaringTypeQualifiedName: qualifiedContainer,
        aliasQualifiedNames: buildScopedMemberAliases(qualifiedContainer, property.name),
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
        visibility: getSymbolVisibility(property),
        detailsData: ['global', qualifiedName],
        namespaceQualifiedName
    });
}

function createSearchEntry(input: {
    qualifiedName: string;
    kind: ApiSearchKind;
    isCallable: boolean;
    isAccessor?: boolean;
    access?: PropertyAccess | FunctionAccess;
    canBlueprintOverride?: true;
    blueprintEventKind?: typedb.BlueprintEventKind;
    signature: string;
    summary?: string;
    documentation?: string;
    docSource?: ApiSearchDocSource;
    containerQualifiedName?: string;
    source: ApiSearchMatchSource;
    filterSource: ApiSearchSource;
    visibility?: ApiSearchVisibility;
    detailsData?: unknown;
    namespaceQualifiedName: string;
    declaringTypeQualifiedName?: string;
    isMixin?: boolean;
    mixinTargetQualifiedName?: string;
    aliasQualifiedNames?: string[];
    overrideKey?: string;
    ownerQualifiedName?: string;
    symbolId?: string;
    args?: ApiConstructorArgument[];
    requiredArgumentCount?: number;
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
        isAccessor: input.isAccessor === true,
        access: input.access,
        canBlueprintOverride: input.canBlueprintOverride,
        blueprintEventKind: input.blueprintEventKind,
        signature: input.signature,
        summary: input.summary,
        documentation: input.documentation,
        docSource: input.docSource,
        containerQualifiedName: input.containerQualifiedName,
        source: input.source,
        filterSource: input.filterSource,
        visibility: input.visibility ?? 'public',
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
        overrideKey: input.overrideKey,
        ownerQualifiedName: input.ownerQualifiedName,
        symbolId: input.symbolId,
        args: input.args,
        requiredArgumentCount: input.requiredArgumentCount
    };
}

function buildScopedMemberAliases(containerQualifiedName: string, memberName: string) : string[]
{
    let aliases = new Array<string>();
    if (!containerQualifiedName || !memberName)
        return aliases;

    aliases.push(`${containerQualifiedName}::${memberName}`);

    let namespaceIndex = containerQualifiedName.lastIndexOf('::');
    if (namespaceIndex >= 0)
    {
        let shortContainerName = containerQualifiedName.substring(namespaceIndex + 2);
        if (shortContainerName.length > 0)
        {
            aliases.push(`${shortContainerName}.${memberName}`);
            aliases.push(`${shortContainerName}::${memberName}`);
        }
    }

    return aliases;
}

function resolveScope(
    index: SearchIndex,
    scopeName: string,
    includeInheritedFromScopeMode: ScopeInheritanceMode
) : ScopeResolution
{
    let notices: GetAPISearchNotice[] = [];
    let normalizedScope = scopeName.trim();
    let normalizedScopeLower = normalizeSearchText(normalizedScope);
    let isQualifiedScope = normalizedScope.includes('::') || normalizedScope.includes('.');

    let exactQualifiedCandidates = index.scopeCandidates.filter((candidate) => normalizeSearchText(candidate.qualifiedName) == normalizedScopeLower);
    let candidates = exactQualifiedCandidates;
    let candidateMatchMode: ScopeCandidateMatchMode = 'exact-qualified';
    if (candidates.length == 0 && !isQualifiedScope)
    {
        let exactShortCandidates = index.scopeCandidates.filter((candidate) => normalizeSearchText(candidate.shortName) == normalizedScopeLower);
        candidates = exactShortCandidates;
        candidateMatchMode = 'exact-short';
    }
    if (candidates.length == 0 && !isQualifiedScope)
    {
        let prefixCandidates = index.scopeCandidates.filter((candidate) => normalizeSearchText(candidate.qualifiedName).startsWith(normalizedScopeLower));
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
    let orderedCandidates = orderMergedScopeCandidates(groups);
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

function orderMergedScopeCandidates(groups: RankedScopeGroup[]) : Array<{ groupIndex: number; candidate: SearchCandidate }>
{
    return orderOwnerSeededGroups(
        groups.map((group) => group.candidates),
        compareCandidates
    ).map((selected) => ({
        groupIndex: selected.groupIndex,
        candidate: selected.item
    }));
}

function orderOwnerSeededGroups<T>(groups: T[][], compareItems: (left: T, right: T) => number) : OwnerSeededItem<T>[]
{
    let orderedItems = new Array<OwnerSeededItem<T>>();
    let nextIndexByGroup = groups.map(() => 0);

    for (let index = 0; index < groups.length; index += 1)
    {
        if (groups[index].length == 0)
            continue;

        orderedItems.push({ groupIndex: index, item: groups[index][0] });
        nextIndexByGroup[index] = 1;
    }

    while (true)
    {
        let bestGroupIndex = -1;
        let bestItem: T | undefined = undefined;

        for (let index = 0; index < groups.length; index += 1)
        {
            let nextItem = groups[index][nextIndexByGroup[index]];
            if (!nextItem)
                continue;

            if (bestItem === undefined || compareItems(nextItem, bestItem) < 0)
            {
                bestItem = nextItem;
                bestGroupIndex = index;
            }
        }

        if (bestGroupIndex == -1 || bestItem === undefined)
            break;

        orderedItems.push({ groupIndex: bestGroupIndex, item: bestItem });
        nextIndexByGroup[bestGroupIndex] += 1;
    }

    return orderedItems;
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
    if (!params.includePrivateOrProtectedMembers && entry.visibility != 'public')
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

    if (entry.kind == 'constructor' || entry.kind == 'method' || entry.kind == 'property')
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

    let leftExactNamespacePriority = getExactNamespacePriority(left);
    let rightExactNamespacePriority = getExactNamespacePriority(right);
    if (leftExactNamespacePriority != rightExactNamespacePriority)
        return rightExactNamespacePriority - leftExactNamespacePriority;

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

function getExactNamespacePriority(candidate: SearchCandidate) : number
{
    if (candidate.entry.kind != 'namespace')
        return 0;
    if (candidate.matchReason == 'exact-qualified')
        return 2;
    if (candidate.matchReason == 'exact-short')
        return 1;
    return 0;
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
        let parsedQuery = parseSmartQuery(trimmedBranch);
        if (parsedQuery.searchableCharCount < QUERY_TOO_SHORT_THRESHOLD)
            throw new ApiSearchValidationError(`Invalid params. Each smart OR branch requires at least ${QUERY_TOO_SHORT_THRESHOLD} searchable Unicode characters.`);
        parsedQueries.push(parsedQuery);
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
        requiresCallable = true;
    }

    if (raw.length == 0 || raw.startsWith('.') || raw.startsWith('::') || raw.endsWith('.') || raw.endsWith('::') || /(^|[^:]):([^:]|$)/.test(raw))
        throw new ApiSearchValidationError("Invalid params. Smart search separators must be '.', '::', or whitespace.");

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

        let normalizedSegment = normalizeSearchText(token);
        if (normalizedSegment.length == 0)
            continue;

        if (segments.length > 0)
            connectors.push(pendingConnector ?? 'space');
        segments.push(normalizedSegment);
        pendingConnector = null;
    }

    return {
        raw,
        rawLower: normalizeSearchText(raw),
        segments,
        connectors,
        hasStrongSeparator,
        searchableCharCount: segments.reduce((total, segment) => total + [...segment].filter((character) => /[\p{L}\p{N}_]/u.test(character)).length, 0),
        requiresCallable,
        requiresLeafTermination
    };
}

function scoreSmartExactMatch(entry: SearchIndexEntry, query: ParsedSmartQuery) : SearchMatchOutcome | null
{
    let qualifiedStructuredMatch = findBestQualifiedStructuredMatch(entry, query);

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
                true
            );
        }
    }

    return null;
}

function scoreSmartOrderedViewsMatch(entry: SearchIndexEntry, query: ParsedSmartQuery) : SearchMatchOutcome | null
{
    let qualifiedStructuredMatch = findBestQualifiedStructuredMatch(entry, query);
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

function findBestQualifiedStructuredMatch(entry: SearchIndexEntry, query: ParsedSmartQuery) : StructuredMatchState | null
{
    let bestMatch = findStructuredMatch(entry.qualifiedText, query);
    for (let alias of entry.qualifiedAliasTexts)
        bestMatch = pickBetterStructuredState(bestMatch, findStructuredMatch(alias, query));
    return bestMatch;
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
    return /[\p{L}\p{N}_]/u.test(value);
}

function buildMatch(candidate: SearchCandidate, includeDocs: boolean) : GetAPISearchMatch
{
    let match: GetAPISearchMatch = {
        qualifiedName: candidate.entry.qualifiedName,
        shortName: candidate.entry.shortName,
        namespaceQualifiedName: candidate.entry.namespaceQualifiedName,
        kind: candidate.entry.kind,
        signature: candidate.entry.signature,
        source: candidate.entry.source,
        visibility: candidate.entry.visibility,
    };

    if (candidate.matchReason)
        match.matchReason = candidate.matchReason;
    if (candidate.entry.summary)
        match.summary = candidate.entry.summary;
    if (includeDocs && candidate.entry.documentation)
    {
        match.documentation = candidate.entry.documentation;
        if (candidate.entry.docSource)
            match.docSource = candidate.entry.docSource;
    }
    if (candidate.entry.containerQualifiedName)
        match.containerQualifiedName = candidate.entry.containerQualifiedName;
    if (candidate.entry.isCallable !== undefined)
        match.isCallable = candidate.entry.isCallable;
    if (candidate.entry.access !== undefined)
        match.access = candidate.entry.access;
    if (candidate.entry.isAccessor)
        match.isAccessor = true;
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
    if (candidate.entry.ownerQualifiedName)
        match.ownerQualifiedName = candidate.entry.ownerQualifiedName;
    if (candidate.entry.symbolId)
        match.symbolId = candidate.entry.symbolId;
    if (candidate.entry.args)
        match.args = candidate.entry.args;
    if (typeof candidate.entry.requiredArgumentCount === 'number')
        match.requiredArgumentCount = candidate.entry.requiredArgumentCount;

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
    return isPublicApiSymbolName(dbType.name)
        && !dbType.isDelegate
        && !dbType.isEvent
        && !dbType.isPrimitive
        && !dbType.isTemplateInstantiation;
}

function isInternalApiSymbolName(name: string | undefined | null) : boolean
{
    return typeof name == 'string' && name.startsWith('__');
}

function isPublicApiSymbolName(name: string | undefined | null) : boolean
{
    return typeof name == 'string' && name != 'StaticClass' && !isInternalApiSymbolName(name);
}

function shouldSkipMethod(method: typedb.DBMethod) : boolean
{
    if (method.isConstructor)
        return !IsEligibleStructConstructor(method);
    if (!isPublicApiSymbolName(method.name))
        return true;
    if (method.name.startsWith('op'))
        return true;
    return false;
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

function createSearchTextVariant(value: string) : SearchTextVariant
{
    return {
        text: value,
        textLower: normalizeSearchText(value),
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

        let normalized = normalizeSearchText(trimmed);
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
    if (dotIndex != -1 && (kind == 'constructor' || kind == 'method' || kind == 'property'))
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
    if (!(raw.length >= 2 && raw.startsWith('/')))
        throw new Error("Expected /pattern/flags syntax.");

    let lastSlash = -1;
    for (let index = raw.length - 1; index > 0; index -= 1)
    {
        if (raw[index] != '/')
            continue;
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && raw[cursor] == '\\'; cursor -= 1)
            slashCount += 1;
        if (slashCount % 2 == 0)
        {
            lastSlash = index;
            break;
        }
    }
    if (lastSlash <= 0)
        throw new Error("Expected /pattern/flags syntax.");
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
