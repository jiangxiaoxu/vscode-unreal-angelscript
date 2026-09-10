/**
 * Normalized AngelScript API access facts shared by the native and watched
 * script type databases.  Restriction codes are deliberately closed: an
 * unknown producer code rejects the access frame instead of becoming a fake
 * restriction that a consumer might render as an explanation.
 */

export type AccessState = 'allowed' | 'denied' | 'unknown';

export type BlueprintEventKind = 'implementable' | 'native';

export type AccessRestrictionCode =
    | 'Editable'
    | 'ConstProperty'
    | 'CustomAccess'
    | 'EditorOnly'
    | 'DefaultsOnly'
    | 'UnsafeDuringActorConstruction';

export type AccessRestriction = {
    code: AccessRestrictionCode;
};

export type AccessDirection = {
    normal: AccessState;
    restricted: AccessState;
    restrictions?: AccessRestriction[];
};

export type PropertyAccess = {
    read: AccessDirection;
    write: AccessDirection;
};

export type FunctionCallAccess = {
    state: AccessState;
    restrictions?: AccessRestriction[];
};

export type FunctionAccess = {
    call: FunctionCallAccess;
};

export type RawAccessState = 'allow' | 'deny' | 'unknown' | AccessState;

export const DEBUG_DATABASE_ACCESS_SCHEMA = 'as-debug-database-access';
export const DEBUG_DATABASE_ACCESS_VERSION = 1;
export const DEBUG_DATABASE_ACCESS_CAPABILITY = 'access-contract-v1';

type RawRestriction = {
    code?: unknown;
    name?: unknown;
};

const KNOWN_RESTRICTIONS = new Set<AccessRestrictionCode>([
    'Editable',
    'ConstProperty',
    'CustomAccess',
    'EditorOnly',
    'DefaultsOnly',
    'UnsafeDuringActorConstruction',
]);

function isRecord(value: unknown) : value is Record<string, unknown>
{
    return value != null && typeof value == 'object' && !Array.isArray(value);
}

export type DebugDatabaseAccessChunk = {
    properties?: Array<{ owner: string; name: string; access: PropertyAccess }>;
    methods?: Array<{
        owner: string;
        kind?: 'method' | 'function' | 'constructor';
        name: string;
        blueprintEventKind?: BlueprintEventKind;
        signature?: string;
        args: Array<{ name?: string; type: string; default?: string }>;
        return?: string;
        access: FunctionAccess;
    }>;
};

export function normalizeDebugDatabaseAccessChunk(raw: unknown) : DebugDatabaseAccessChunk
{
    if (!isRecord(raw))
        throw new Error('DebugDatabaseAccess payload must be an object.');
    let result: DebugDatabaseAccessChunk = {};
    if (raw.__meta !== undefined)
        throw new Error('DebugDatabaseAccess metadata must be declared by DebugDatabaseSettings.');
    if (raw.properties !== undefined)
    {
        if (!Array.isArray(raw.properties))
            throw new Error('DebugDatabaseAccess properties must be an array.');
        result.properties = raw.properties.map((entry) => {
            if (!isRecord(entry) || typeof entry.owner != 'string' || typeof entry.name != 'string')
                throw new Error('DebugDatabaseAccess property identity is invalid.');
            let access = normalizePropertyAccess(entry.access);
            if (!access)
                throw new Error(`DebugDatabaseAccess property ${entry.owner}.${entry.name} access is invalid.`);
            return { owner: entry.owner, name: entry.name, access };
        });
    }
    if (raw.methods !== undefined)
    {
        if (!Array.isArray(raw.methods))
            throw new Error('DebugDatabaseAccess methods must be an array.');
        result.methods = raw.methods.map((entry) => {
            if (!isRecord(entry) || typeof entry.owner != 'string' || typeof entry.name != 'string'
                || (entry.kind !== undefined && entry.kind != 'method' && entry.kind != 'function' && entry.kind != 'constructor')
                || (entry.blueprintEventKind !== undefined
                    && entry.kind != 'method')
                || (entry.blueprintEventKind !== undefined
                    && entry.blueprintEventKind != 'implementable'
                    && entry.blueprintEventKind != 'native')
                || !Array.isArray(entry.args)
                || entry.args.some((arg) => !isRecord(arg) || typeof arg.type != 'string'))
                throw new Error('DebugDatabaseAccess method identity is invalid.');
            let access = normalizeFunctionAccess(entry.access);
            if (!access)
                throw new Error(`DebugDatabaseAccess method ${entry.owner}.${entry.name} access is invalid.`);
            let kind = entry.kind as 'method' | 'function' | 'constructor' | undefined;
            let blueprintEventKind = entry.blueprintEventKind as BlueprintEventKind | undefined;
            return {
                owner: entry.owner,
                ...(kind !== undefined ? { kind } : {}),
                name: entry.name,
                ...(blueprintEventKind !== undefined ? { blueprintEventKind } : {}),
                ...(typeof entry.signature == 'string' ? { signature: entry.signature } : {}),
                args: entry.args.map((arg) => ({
                    ...(typeof arg.name == 'string' ? { name: arg.name } : {}),
                    type: arg.type as string,
                    ...(typeof arg.default == 'string' ? { default: arg.default } : {}),
                })),
                ...(typeof entry.return == 'string' ? { return: entry.return } : {}),
                access,
            };
        });
    }
    return result;
}

function normalizeState(value: unknown) : AccessState | null
{
    if (value == 'allow' || value == 'allowed')
        return 'allowed';
    if (value == 'deny' || value == 'denied')
        return 'denied';
    if (value == 'unknown')
        return 'unknown';
    return null;
}

function restrictionCode(value: unknown) : AccessRestrictionCode
{
    let code = typeof value == 'string' ? value : '';
    if (!KNOWN_RESTRICTIONS.has(code as AccessRestrictionCode))
        throw new Error(`Unsupported access restriction code: ${code || '<missing>'}.`);
    return code as AccessRestrictionCode;
}

export function normalizeRestriction(raw: unknown) : AccessRestriction
{
    let value = isRecord(raw) ? raw as RawRestriction : {};
    let code = restrictionCode(value.code ?? value.name);
    return { code };
}

export function normalizeRestrictions(raw: unknown) : AccessRestriction[] | undefined
{
    if (raw === undefined)
        return undefined;
    if (!Array.isArray(raw) || raw.length == 0)
        throw new Error('Access restrictions must be a non-empty array when present.');
    let result: AccessRestriction[] = [];
    let seen = new Set<AccessRestrictionCode>();
    for (let value of raw)
    {
        let restriction = normalizeRestriction(value);
        if (seen.has(restriction.code))
            throw new Error(`Duplicate access restriction code: ${restriction.code}.`);
        seen.add(restriction.code);
        result.push(restriction);
    }
    return result;
}

export function normalizeAccessState(raw: unknown) : AccessState
{
    return normalizeState(raw) ?? 'unknown';
}

function normalizeDirection(raw: unknown) : AccessDirection | null
{
    if (!isRecord(raw))
        return null;
    if (!('normal' in raw) || !('restricted' in raw))
        return null;
    let normal = normalizeState(raw.normal);
    let restricted = normalizeState(raw.restricted);
    if (!normal || !restricted)
        return null;
    let restrictions = normalizeRestrictions(raw.restrictions);
    if (normal != restricted && (!restrictions || restrictions.length == 0))
        return null;
    if ((normal == 'unknown' || restricted == 'unknown')
        && (!restrictions || restrictions.length == 0))
        return null;
    let direction: AccessDirection = {
        normal,
        restricted,
    };
    if (restrictions !== undefined)
        direction.restrictions = restrictions;
    return direction;
}

export function normalizePropertyAccess(raw: unknown) : PropertyAccess | null
{
    if (!isRecord(raw))
        return null;
    let read = normalizeDirection(raw.read);
    let write = normalizeDirection(raw.write);
    if (!read || !write)
        return null;
    return { read, write };
}

export function normalizeFunctionAccess(raw: unknown) : FunctionAccess | null
{
    if (!isRecord(raw))
        return null;
    let callRaw = isRecord(raw.call) ? raw.call : null;
    if (!callRaw)
        return null;
    if (!('state' in callRaw))
        return null;
    let state = normalizeState(callRaw.state);
    if (!state)
        return null;
    let restrictions = normalizeRestrictions(callRaw.restrictions);
    if (state == 'unknown' && (!restrictions || restrictions.length == 0))
        return null;
    let call: FunctionCallAccess = {
        state,
    };
    if (restrictions !== undefined)
        call.restrictions = restrictions;
    return { call };
}

export function propertyAccessIsComplete(raw: unknown) : boolean
{
    let value = normalizePropertyAccess(raw);
    return value != null
        && value.read.normal != 'unknown'
        && value.read.restricted != 'unknown'
        && value.write.normal != 'unknown'
        && value.write.restricted != 'unknown';
}

export function functionAccessIsComplete(raw: unknown) : boolean
{
    let value = normalizeFunctionAccess(raw);
    return value != null && value.call.state != 'unknown';
}

export function scriptPropertyAccess(
    options: { isConst?: boolean; hasCustomAccess?: boolean } = {},
) : PropertyAccess
{
    let restrictions: AccessRestriction[] = [];
    if (options.hasCustomAccess)
        restrictions.push(normalizeRestriction({ code: 'CustomAccess' }));

    // The normal AngelScript property path is read/write.  A const declaration
    // has a known normal read-only path and is writable in the compiler's
    // restricted initialization context. Custom access depends on the caller
    // and remains explicitly unknown in both contexts.
    let read: AccessDirection = {
        normal: options.hasCustomAccess ? 'unknown' : 'allowed',
        restricted: options.hasCustomAccess ? 'unknown' : 'allowed',
    };
    let write: AccessDirection = {
        normal: options.hasCustomAccess ? 'unknown' : options.isConst ? 'denied' : 'allowed',
        restricted: options.hasCustomAccess ? 'unknown' : 'allowed',
    };
    if (restrictions.length > 0)
    {
        read.restrictions = restrictions;
        write.restrictions = restrictions;
    }
    if (options.isConst)
    {
        if (write.restrictions)
            write.restrictions = [...write.restrictions, normalizeRestriction({ code: 'ConstProperty' })];
        else
            write.restrictions = [normalizeRestriction({ code: 'ConstProperty' })];
    }
    return { read, write };
}

export function scriptFunctionAccess(restrictions: AccessRestrictionCode[] = []) : FunctionAccess
{
    let normalized = restrictions.map((code) => normalizeRestriction({ code }));
    let call: FunctionCallAccess = { state: 'allowed' };
    if (normalized.length > 0)
        call.restrictions = normalized;
    return { call };
}

export function unknownPropertyAccess() : PropertyAccess
{
    return {
        read: { normal: 'unknown', restricted: 'unknown' },
        write: { normal: 'unknown', restricted: 'unknown' },
    };
}

export function unknownFunctionAccess() : FunctionAccess
{
    return {
        call: {
            state: 'unknown',
        },
    };
}

/** Project a generated get/set accessor into the public property shape. */
export function accessorPropertyAccess(
    access: FunctionAccess | null | undefined,
    kind: 'get' | 'set',
) : PropertyAccess
{
    let call = access?.call ?? unknownFunctionAccess().call;
    let available: AccessDirection = {
        normal: call.state,
        restricted: call.state,
        ...(call.restrictions ? { restrictions: call.restrictions } : {}),
    };
    let unavailable: AccessDirection = { normal: 'denied', restricted: 'denied' };
    return kind == 'get'
        ? { read: available, write: unavailable }
        : { read: unavailable, write: available };
}
