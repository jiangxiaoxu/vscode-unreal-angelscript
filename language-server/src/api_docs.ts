import * as scriptfiles from './as_parser';
import * as typedb from './database';
import * as documentation from './documentation';
import {
    accessorPropertyAccess,
    unknownFunctionAccess,
    unknownPropertyAccess,
} from './accessContract';
import type { FunctionAccess, PropertyAccess } from './accessContract';
import {
    GetAPIExactSymbols,
    GetConstructorSymbolIdPrefix,
    ProjectConstructor,
    type ApiQueryMatch,
    type ApiConstructorArgument,
    type ApiConstructorProjection,
} from './api_search';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

type ApiSearchSource = "native" | "script" | "both";
type ApiDeclaredSource = Exclude<ApiSearchSource, "both">;

type TypeMemberVisibility = "public" | "protected" | "private";

type CollectedTypeMember = {
    kind: "constructor" | "method" | "property";
    name: string;
    qualifiedName?: string;
    signature: string;
    description: string;
    declaredIn: string;
    declaredInKind: "type" | "namespace";
    isInherited: boolean;
    isMixin: boolean;
    isAccessor: boolean;
    accessorKind?: "get" | "set";
    propertyName?: string;
    visibility: TypeMemberVisibility;
    ownerQualifiedName?: string;
    args?: ApiConstructorArgument[];
    source: ApiDeclaredSource;
    isCallable?: boolean;
    access?: PropertyAccess | FunctionAccess;
    canBlueprintOverride?: true;
    symbolId?: string;
    requiredArgumentCount?: number;
};

function normalizeSearchSource(raw: unknown) : ApiSearchSource
{
    if (typeof raw !== "string")
        return "both";
    let value = raw.trim().toLowerCase();
    if (value == "" || value == "both")
        return "both";
    if (value == "native")
        return "native";
    if (value == "script")
        return "script";
    return "both";
}

function matchesSearchSource(declaredModule: string | null | undefined, source: ApiSearchSource) : boolean
{
    if (source == "both")
        return true;
    return sourceOfDeclaredModule(declaredModule) == source;
}

function sourceOfDeclaredModule(declaredModule: string | null | undefined) : ApiDeclaredSource
{
    return typeof declaredModule == "string" && declaredModule.length > 0 ? "script" : "native";
}

function isNativeBlueprintOverrideTarget(method: typedb.DBMethod) : boolean
{
    return method.containingType != null && method.declaredModule == null && method.isBlueprintEvent;
}

function isClassType(dbType: typedb.DBType) : boolean
{
    if (!dbType)
        return false;
    return !dbType.isPrimitive && !dbType.isEnum && !dbType.isStruct && !dbType.isDelegate && !dbType.isEvent;
}

function getLineFromOffset(content: string, offset: number) : number
{
    let safeOffset = offset;
    if (safeOffset < 0)
        safeOffset = 0;
    if (safeOffset > content.length)
        safeOffset = content.length;

    let line = 1;
    for (let i = 0; i < safeOffset; ++i)
    {
        if (content.charCodeAt(i) == 10)
            line += 1;
    }
    return line;
}

function getAbsoluteModulePath(module: scriptfiles.ASModule | null) : string
{
    if (!module)
        return "";

    let filename = typeof module.filename === "string" ? module.filename.trim() : "";
    if (filename.length != 0 && path.isAbsolute(filename))
        return path.normalize(filename);

    let displayUri = typeof module.displayUri === "string" ? module.displayUri.trim() : "";
    if (!displayUri.startsWith("file://"))
        return "";

    try
    {
        return path.normalize(fileURLToPath(displayUri));
    }
    catch
    {
        return "";
    }
}

function findLastMatchIndex(text: string, regex: RegExp) : number
{
    let flags = regex.flags;
    if (!flags.includes("g"))
        flags += "g";

    let matchRegex = new RegExp(regex.source, flags);
    let match : RegExpExecArray = null;
    let foundIndex = -1;
    while ((match = matchRegex.exec(text)) !== null)
    {
        foundIndex = match.index ?? -1;
        if (match[0].length == 0)
            matchRegex.lastIndex += 1;
    }

    return foundIndex;
}

function getClassStartOffset(content: string, scopeStartOffset: number, nameOffset: number) : number
{
    if (!content)
        return nameOffset;

    let safeScopeStart = scopeStartOffset;
    let safeNameOffset = nameOffset;
    if (safeScopeStart < 0)
        safeScopeStart = 0;
    if (safeScopeStart > content.length)
        safeScopeStart = content.length;

    if (safeNameOffset < safeScopeStart)
        safeNameOffset = safeScopeStart;
    if (safeNameOffset > content.length)
        safeNameOffset = content.length;

    let header = content.substring(safeScopeStart, safeNameOffset);
    if (header.length == 0)
        return safeNameOffset;

    let macroIndex = findLastMatchIndex(header, /UCLASS\s*\(/);
    if (macroIndex >= 0)
        return safeScopeStart + macroIndex;

    let classIndex = findLastMatchIndex(header, /\bclass\b/);
    if (classIndex >= 0)
        return safeScopeStart + classIndex;

    return safeNameOffset;
}

function getScriptClassSourceInfo(dbType: typedb.DBType) : {
    source: "cpp";
} | {
    source: "as";
    filePath: string;
    startLine: number;
    endLine: number;
}
{
    if (dbType.isUnrealType())
        return { source: "cpp" };

    let moduleName = dbType.declaredModule;
    let module = scriptfiles.GetModule(moduleName);
    let filePath = getAbsoluteModulePath(module);

    if (!moduleName || moduleName.length == 0 || filePath.length == 0)
    {
        return {
            source: "as",
            filePath: filePath,
            startLine: 1,
            endLine: 1,
        };
    }

    let scopeStartOffset = dbType.moduleScopeStart >= 0 ? dbType.moduleScopeStart : dbType.moduleOffset;
    let nameOffset = dbType.moduleOffset >= 0 ? dbType.moduleOffset : scopeStartOffset;
    if (nameOffset < scopeStartOffset)
        nameOffset = scopeStartOffset;

    let endOffset = dbType.moduleOffsetEnd;
    if (dbType.moduleScopeEnd > nameOffset)
        endOffset = dbType.moduleScopeEnd;
    if (endOffset < nameOffset)
        endOffset = nameOffset;

    if (module && module.loaded && module.textDocument)
    {
        let startOffset = getClassStartOffset(module.content, scopeStartOffset, nameOffset);
        let startLine = module.getPosition(startOffset).line + 1;
        let endLine = module.getPosition(endOffset).line + 1;
        if (endLine < startLine)
            endLine = startLine;
        return {
            source: "as",
            filePath: filePath,
            startLine: startLine,
            endLine: endLine,
        };
    }

    if (module && module.filename && module.filename.length != 0)
    {
        try
        {
            let content = fs.readFileSync(module.filename, "utf8");
            let startOffset = getClassStartOffset(content, scopeStartOffset, nameOffset);
            let startLine = getLineFromOffset(content, startOffset);
            let endLine = getLineFromOffset(content, endOffset);
            if (endLine < startLine)
                endLine = startLine;
            return {
                source: "as",
                filePath: filePath,
                startLine: startLine,
                endLine: endLine,
            };
        }
        catch
        {
        }
    }

    return {
        source: "as",
        filePath: filePath,
        startLine: 1,
        endLine: 1,
    };
}

function resolveHierarchySuperType(dbType: typedb.DBType) : typedb.DBType | null
{
    if (!dbType)
        return null;
    if (dbType.supertype)
    {
        let superType = typedb.LookupType(dbType.namespace, dbType.supertype) ?? typedb.GetTypeByName(dbType.supertype);
        if (isClassType(superType))
            return superType;
    }
    if (dbType.unrealsuper)
    {
        let unrealSuper = typedb.LookupType(dbType.namespace, dbType.unrealsuper) ?? typedb.GetTypeByName(dbType.unrealsuper);
        if (isClassType(unrealSuper))
            return unrealSuper;
    }
    return null;
}

function getTypeVisibility(isPrivate: boolean, isProtected: boolean) : TypeMemberVisibility
{
    if (isPrivate)
        return "private";
    if (isProtected)
        return "protected";
    return "public";
}

function getVisibilityPrefix(visibility: TypeMemberVisibility) : string
{
    if (visibility == "private")
        return "private ";
    if (visibility == "protected")
        return "protected ";
    return "";
}

function formatFunctionDocumentationPlain(doc : string) : string
{
    if (!doc)
        return "";
    let lines = doc.split("\n");
    let result : Array<string> = [];

    for (let line of lines)
    {
        let trimmed = line.trim();
        if (trimmed.startsWith("@param"))
        {
            let match = trimmed.match(/@param\s+([A-Za-z0-9_]+)\s*(.*)/);
            if (match)
            {
                let name = match[1];
                let desc = match[2] ?? "";
                let entry = desc.length > 0 ? `param ${name}: ${desc}` : `param ${name}`;
                result.push(entry.trim());
                continue;
            }
        }
        if (trimmed.startsWith("@return"))
        {
            let desc = trimmed.substring(7).trim();
            result.push(desc.length > 0 ? `return: ${desc}` : "return");
            continue;
        }
        if (trimmed.startsWith("@note"))
        {
            let desc = trimmed.substring(5).trim();
            result.push(desc.length > 0 ? `note: ${desc}` : "note");
            continue;
        }
        if (trimmed.startsWith("@see"))
        {
            let desc = trimmed.substring(4).trim();
            result.push(desc.length > 0 ? `see: ${desc}` : "see");
            continue;
        }
        if (trimmed.length > 0)
            result.push(trimmed);
        else
            result.push("");
    }

    return result.join("\n").trim();
}

function formatPropertyDocumentationPlain(doc : string) : string
{
    if (!doc)
        return "";
    let lines = doc.split("\n");
    let result : Array<string> = [];

    for (let line of lines)
    {
        let trimmed = line.trim();
        if (trimmed.startsWith("@note"))
        {
            let desc = trimmed.substring(5).trim();
            result.push(desc.length > 0 ? `note: ${desc}` : "note");
            continue;
        }
        if (trimmed.startsWith("@see"))
        {
            let desc = trimmed.substring(4).trim();
            result.push(desc.length > 0 ? `see: ${desc}` : "see");
            continue;
        }
        if (trimmed.length > 0)
            result.push(trimmed);
        else
            result.push("");
    }

    return result.join("\n").trim();
}

function buildAccessorSignature(method: typedb.DBMethod, prefix: string, accessorKind: "get" | "set", propertyName: string) : string
{
    if (accessorKind == "get")
        return `${method.returnType} ${prefix}${propertyName}`;
    if (method.isMixin)
    {
        if (method.args && method.args.length > 1)
            return `${method.args[1].typename} ${prefix}${propertyName}`;
    }
    if (method.args && method.args.length > 0)
        return `${method.args[0].typename} ${prefix}${propertyName}`;
    return `${method.returnType} ${prefix}${propertyName}`;
}

function getPropertyAccessorInfo(method: typedb.DBMethod) : {
    isAccessor: boolean;
    accessorKind?: "get" | "set";
    propertyName?: string;
}
{
    if (!method.isProperty || method.isConstructor)
        return { isAccessor: false };

    let implicitArgumentCount = method.isMixin ? 1 : 0;
    let argumentCount = method.args?.length ?? 0;
    if (method.name.startsWith("Get"))
    {
        let propertyName = method.name.substring(3);
        if (propertyName.length > 0 && argumentCount == implicitArgumentCount && method.returnType != "void")
            return { isAccessor: true, accessorKind: "get", propertyName };
    }
    else if (method.name.startsWith("Set"))
    {
        let propertyName = method.name.substring(3);
        if (propertyName.length > 0 && argumentCount == implicitArgumentCount + 1 && method.returnType == "void")
            return { isAccessor: true, accessorKind: "set", propertyName };
    }

    return { isAccessor: false };
}

function buildMethodSignature(method: typedb.DBMethod, declaredInName: string, isAccessor: boolean, accessorKind: "get" | "set" | null, propertyName: string | null) : string
{
    let prefix = "";
    let skipFirstArg = false;
    if (method.isMixin)
    {
        if (method.args && method.args.length > 0)
            prefix = method.args[0].typename + ".";
        skipFirstArg = true;
    }
    else if (declaredInName && declaredInName.length > 0)
    {
        prefix = declaredInName + ".";
    }

    if (isAccessor && accessorKind && propertyName)
        return buildAccessorSignature(method, prefix, accessorKind, propertyName);

    return method.format(prefix, skipFirstArg);
}

export function GetAPIList(root: string): any
{
    let list: any[] = [];

    // Strip away the prefixes that are needed for cases where a namespace and a property with the same name can both exist next to each other
    root = root.replace(/__(ns|fun|prop)_/, "");

    let addType = function (type: typedb.DBType | typedb.DBNamespace)
    {
        if (type instanceof typedb.DBNamespace)
        {
            for (let [_, childNamespace] of type.childNamespaces)
            {
                if (isNamespaceApiEmpty(childNamespace))
                    continue;

                list.push({
                    "type": "namespace",
                    "id": childNamespace.getQualifiedNamespace(),
                    "data": ["namespace", childNamespace.getQualifiedNamespace()],
                    "label": childNamespace.getQualifiedNamespace() + "::",
                });
            }

            if (type.isRootNamespace())
            {
                list.sort(function (a, b)
                {
                    if (a.label < b.label)
                        return -1;
                    else if (a.label > b.label)
                        return 1;
                    else
                        return 0;
                });
                return;
            }
        }

        type.forEachSymbol(function (symbol: typedb.DBSymbol)
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (symbol.isMixin)
                    return;
                list.push({
                    "type": "function",
                    "label": symbol.name + "()",
                    "id": symbol.id.toString(),
                    "data": ["function", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name, symbol.id],
                });
            }
            else if (symbol instanceof typedb.DBProperty)
            {
                list.push({
                    "type": "property",
                    "label": symbol.name,
                    "id": symbol.namespace.getQualifiedNamespace() + "::" + symbol.name,
                    "data": ["global", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name],
                });
            }
        });
    }

    if (!root)
    {
        addType(typedb.GetRootNamespace());
    }
    else
    {
        let namespace = typedb.LookupNamespace(null, root);
        if (namespace)
        {
            addType(namespace);
        }
    }

    return list;
}

export function GetAPIDetails(data: any): any
{
    if (data[0] == "namespace")
    {
        let namespace = typedb.LookupNamespace(null, data[1]);
        if (namespace)
        {
            return namespace.documentation ?? "";
        }
    }
    else if (data[0] == "constructor")
    {
        let namespaceName = typeof data[2] == "string" ? data[2] : "";
        let namespace = namespaceName ? typedb.LookupNamespace(null, namespaceName) : typedb.GetRootNamespace();
        let owner = namespace ? typedb.LookupType(namespace, data[1]) : typedb.GetTypeByName(data[1]);
        if (!owner)
            return "";
        let requestedSymbolId = typeof data[3] == "string" ? data[3] : "";
        let selected: ApiConstructorProjection | null = null;
        owner.forEachSymbol((symbol: typedb.DBSymbol) =>
        {
            if (selected || !(symbol instanceof typedb.DBMethod))
                return;
            let constructor = ProjectConstructor(symbol, owner);
            if (constructor && (!requestedSymbolId || constructor.symbolId == requestedSymbolId))
                selected = constructor;
        }, false);
        if (!selected)
            return "";
        let details = "```angelscript_snippet\n" + selected.declaration + "\n```\n";
        if (selected.documentation)
            details += selected.documentation;
        return details;
    }
    else if (data[0] == "function" || data[0] == "method")
    {
        let method: typedb.DBMethod;
        let symbols: Array<typedb.DBSymbol>;
        let method_id = 0;
        if (data[0] == "function")
        {
            symbols = typedb.LookupGlobalSymbol(null, data[1]);
            if (typeof data[2] === "number")
                method_id = data[2];
        }
        else
        {
            let typeNamespaceName = typeof data[4] === "string" ? data[4] : "";
            let typeNamespace = null;
            if (typeNamespaceName.length > 0)
                typeNamespace = typedb.LookupNamespace(null, typeNamespaceName);
            else if (typeNamespaceName === "")
                typeNamespace = typedb.GetRootNamespace();
            let dbType = typeNamespace ? typedb.LookupType(typeNamespace, data[1]) : typedb.GetTypeByName(data[1]);
            if (!dbType && typeNamespace)
                dbType = typedb.GetTypeByName(data[1]);
            if (dbType)
                symbols = dbType.findSymbols(data[2]);
            if (typeof data[3] === "number")
                method_id = data[3];
        }

        if (method_id != 0)
        {
            for (let symbol of symbols)
            {
                if (symbol instanceof typedb.DBMethod)
                {
                    if (symbol.id != method_id)
                        continue;
                    method = symbol;
                }
            }
        }

        if (!method)
        {
            let signature: Array<string> = null;
            if (Array.isArray(data[4]))
                signature = data[4];
            else if (Array.isArray(data[5]))
                signature = data[5];
            else if (Array.isArray(data[3]))
                signature = data[3];

            if (signature)
            {
                for (let symbol of symbols)
                {
                    if (!(symbol instanceof typedb.DBMethod))
                        continue;
                    let args = symbol.args ?? [];
                    if (args.length != signature.length)
                        continue;
                    let matches = true;
                    for (let i = 0; i < signature.length; ++i)
                    {
                        if (!typedb.TypenameEquals(args[i].typename, signature[i]))
                        {
                            matches = false;
                            break;
                        }
                    }
                    if (matches)
                    {
                        method = symbol;
                        break;
                    }
                }
            }

            if (!method)
            {
                for (let symbol of symbols)
                {
                    if (symbol instanceof typedb.DBMethod)
                    {
                        method = symbol;
                    }
                }
            }
        }

        if (!method)
            return ""

        let details = "```angelscript_snippet\n";
        details += method.returnType;
        details += " ";
        if (method.containingType)
        {
            details += method.containingType.getQualifiedTypenameInNamespace(null);
            details += ".";
        }
        else if (method.isMixin)
        {
            details += method.args[0].typename;
            details += ".";
        }
        else
        {
            details += method.namespace.getQualifiedNamespace();
            details += "::";
        }

        details += method.name;

        if (method.args && method.args.length > 0)
        {
            details += "(";
            for (let i = 0; i < method.args.length; ++i)
            {
                if (method.isMixin && i == 0)
                    continue;
                details += "\n\t\t";
                details += method.args[i].format();
                if (i + 1 < method.args.length)
                    details += ",";
            }
            details += "\n)";
        }
        else
        {
            details += "()";
        }

        details += "\n```\n";

        let doc = method.findAvailableDocumentation();
        if (doc)
            details += documentation.FormatFunctionDocumentation(doc, method);

        return details;
    }
    else if (data[0] == "global")
    {
        let symbols = typedb.LookupGlobalSymbol(null, data[1]);
        for (let symbol of symbols)
        {
            if (symbol instanceof typedb.DBProperty)
            {
                let details = "```angelscript_snippet\n" + symbol.format(
                    symbol.namespace.getQualifiedNamespace() + "::"
                ) + "\n```\n";
                details += documentation.FormatPropertyDocumentation(symbol.documentation);

                return details;
            }
        }
    }
    else if (data[0] == "property")
    {
        let dbType = typedb.GetTypeByName(data[1]);
        if (!dbType)
            return "";
        let symbols = dbType.findSymbols(data[2]);
        for (let symbol of symbols)
        {
            if (symbol instanceof typedb.DBProperty)
            {
                let details = "```angelscript_snippet\n" + symbol.format(
                    symbol.containingType.getQualifiedTypenameInNamespace(null) + "."
                ) + "\n```\n";
                details += documentation.FormatPropertyDocumentation(symbol.documentation);

                return details;
            }
        }
    }
    else if (data[0] == "type")
    {
        let typeNamespaceName = typeof data[2] === "string" ? data[2] : "";
        let typeNamespace = null;
        if (typeNamespaceName.length > 0)
            typeNamespace = typedb.LookupNamespace(null, typeNamespaceName);
        else if (typeNamespaceName === "")
            typeNamespace = typedb.GetRootNamespace();

        let dbType = typeNamespace ? typedb.LookupType(typeNamespace, data[1]) : typedb.GetTypeByName(data[1]);
        if (!dbType && typeNamespace)
            dbType = typedb.GetTypeByName(data[1]);
        if (!dbType)
            return "";

        let details = "```angelscript_snippet\n";
        if (dbType.isEnum)
            details += "enum ";
        else if (dbType.isStruct)
            details += "struct ";
        else
            details += "class ";
        details += dbType.getQualifiedTypenameInNamespace(null);
        if (dbType.supertype && !dbType.isEnum)
            details += " : " + dbType.supertype;
        details += "\n```\n";

        if (dbType.documentation)
            details += documentation.FormatPropertyDocumentation(dbType.documentation);

        return details;
    }

    return "";
}

export function GetAPIDetailsBatch(dataList: any[]): any
{
    if (!Array.isArray(dataList) || dataList.length == 0)
        return [];

    return dataList.map((data) => GetAPIDetails(data));
}

function collectTypeMemberRecords(
    dbType: typedb.DBType,
    categories: ApiMemberCategory[],
    includeInherited: boolean,
    includeDocs: boolean,
    includeNonPublic: boolean
) : CollectedTypeMember[]
{
    let allowConstructors = categories.includes('constructor');
    let allowMethods = categories.includes('callable') || categories.includes('data');
    let allowProperties = categories.includes('data');
    let members: CollectedTypeMember[] = [];
    let seenMembers = new Set<string>();
    let typeList = includeInherited ? dbType.getExtendTypesList() : [dbType];

    for (let checkType of typeList)
    {
        let declaredInName = checkType.getQualifiedTypenameInNamespace(null);
        let isInherited = checkType != dbType;

        checkType.forEachSymbol(function (symbol: typedb.DBSymbol)
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (symbol.isConstructor)
                {
                    if (!allowConstructors || isInherited)
                        return;
                    let constructor = ProjectConstructor(symbol, checkType);
                    if (!constructor || seenMembers.has(`constructor|${constructor.symbolId}`))
                        return;
                    seenMembers.add(`constructor|${constructor.symbolId}`);
                    let visibility = getTypeVisibility(symbol.isPrivate, symbol.isProtected);
                    members.push({
                        kind: "constructor",
                        name: constructor.name,
                        qualifiedName: constructor.qualifiedName,
                        signature: getVisibilityPrefix(visibility) + constructor.declaration,
                        description: includeDocs ? (constructor.documentation ?? "") : "",
                        declaredIn: constructor.ownerQualifiedName,
                        declaredInKind: "type",
                        isInherited: false,
                        isMixin: false,
                        isAccessor: false,
                        visibility,
                        ownerQualifiedName: constructor.ownerQualifiedName,
                        args: constructor.args,
                        source: constructor.source,
                        isCallable: true,
                        symbolId: constructor.symbolId,
                        requiredArgumentCount: constructor.requiredArgumentCount,
                    });
                    return;
                }
                if (!allowMethods)
                    return;
                if (isInternalApiSymbolName(symbol.name))
                    return;
                if (isInherited && symbol.isPrivate)
                    return;

                let visibility = getTypeVisibility(symbol.isPrivate, symbol.isProtected);
                let accessor = getPropertyAccessorInfo(symbol);
                let accessorKind = accessor.accessorKind ?? null;
                let propertyName = accessor.propertyName ?? null;
                let isAccessor = symbol.isProperty === true;

                let signature = buildMethodSignature(symbol, declaredInName, isAccessor, accessorKind, propertyName);
                let description = "";
                if (includeDocs)
                    description = formatFunctionDocumentationPlain(symbol.findAvailableDocumentation());

                signature = getVisibilityPrefix(visibility) + signature;

                let key = `method|${symbol.id}|${declaredInName}`;
                if (seenMembers.has(key))
                    return;
                seenMembers.add(key);

                members.push({
                    kind: isAccessor ? "property" : "method",
                    name: symbol.name,
                    signature: signature,
                    description: description ?? "",
                    declaredIn: declaredInName,
                    declaredInKind: "type",
                    isInherited: isInherited,
                    isMixin: symbol.isMixin,
                    isAccessor: isAccessor,
                    accessorKind: accessorKind ?? undefined,
                    propertyName: propertyName ?? undefined,
                    visibility: visibility,
                    source: sourceOfDeclaredModule(symbol.declaredModule),
                    isCallable: symbol.isCallable !== false,
                    access: isAccessor
                        ? (accessorKind ? accessorPropertyAccess(symbol.access, accessorKind) : unknownPropertyAccess())
                        : symbol.access ?? unknownFunctionAccess(),
                    ...(isNativeBlueprintOverrideTarget(symbol) ? { canBlueprintOverride: true } : {}),
                });
            }
            else if (symbol instanceof typedb.DBProperty)
            {
                if (!allowProperties)
                    return;
                if (isInternalApiSymbolName(symbol.name))
                    return;
                if (isInherited && symbol.isPrivate)
                    return;

                let visibility = getTypeVisibility(symbol.isPrivate, symbol.isProtected);
                let prefix = declaredInName.length > 0 ? declaredInName + "." : "";
                let signature = symbol.format(prefix);
                let description = "";
                if (includeDocs)
                    description = formatPropertyDocumentationPlain(symbol.documentation);

                let memberSource = sourceOfDeclaredModule(symbol.declaredModule);
                let key = `property|${memberSource}|${declaredInName}|${symbol.name}|${symbol.typename}`;
                if (seenMembers.has(key))
                    return;
                seenMembers.add(key);

                members.push({
                    kind: "property",
                    name: symbol.name,
                    signature: signature,
                    description: description ?? "",
                    declaredIn: declaredInName,
                    declaredInKind: "type",
                    isInherited: isInherited,
                    isMixin: false,
                    isAccessor: false,
                    visibility: visibility,
                    source: memberSource,
                    access: symbol.access ?? unknownPropertyAccess(),
                });
            }
        }, false);
    }

    let mixinSeen = new Set<number>();
    let visitNamespace = function (namespace: typedb.DBNamespace)
    {
        if (!allowMethods)
            return;
        namespace.forEachSymbol(function (symbol: typedb.DBSymbol)
        {
            if (!(symbol instanceof typedb.DBMethod))
                return;
            if (!symbol.isMixin)
                return;
            if (isInternalApiSymbolName(symbol.name))
                return;
            if (!symbol.args || symbol.args.length == 0)
                return;
            if (!dbType.inheritsFrom(symbol.args[0].typename))
                return;

            if (mixinSeen.has(symbol.id))
                return;
            mixinSeen.add(symbol.id);

            let namespaceName = namespace.isRootNamespace() ? "" : namespace.getQualifiedNamespace();
            let visibility = getTypeVisibility(symbol.isPrivate, symbol.isProtected);
            let accessor = getPropertyAccessorInfo(symbol);
            let accessorKind = accessor.accessorKind ?? null;
            let propertyName = accessor.propertyName ?? null;
            let isAccessor = symbol.isProperty === true;

            let signature = buildMethodSignature(symbol, "", isAccessor, accessorKind, propertyName);
            let description = "";
            if (includeDocs)
                description = formatFunctionDocumentationPlain(symbol.findAvailableDocumentation());
            signature = getVisibilityPrefix(visibility) + signature;

            members.push({
                kind: isAccessor ? "property" : "method",
                name: symbol.name,
                signature: signature,
                description: description ?? "",
                declaredIn: namespaceName,
                declaredInKind: "namespace",
                isInherited: false,
                isMixin: true,
                isAccessor: isAccessor,
                accessorKind: accessorKind ?? undefined,
                propertyName: propertyName ?? undefined,
                visibility: visibility,
                source: sourceOfDeclaredModule(symbol.declaredModule),
                isCallable: symbol.isCallable !== false,
                access: isAccessor
                    ? (accessor.accessorKind ? accessorPropertyAccess(symbol.access, accessor.accessorKind) : unknownPropertyAccess())
                    : symbol.access ?? unknownFunctionAccess(),
            });
        });

        for (let [_, child] of namespace.childNamespaces)
            visitNamespace(child);
    };

    visitNamespace(typedb.GetRootNamespace());

    if (!includeNonPublic)
        members = members.filter((member) => member.visibility == "public");

    return members;
}

export type ApiMemberCategory = 'callable' | 'data' | 'constructor' | 'type';
export type ApiMemberOwnerKind = 'all' | 'namespace' | 'type';

export type GetAPISymbolMembersParams = {
    name: string;
    source?: ApiSearchSource;
    ownerKind?: ApiMemberOwnerKind;
    members: ApiMemberCategory[] | ['all'];
    includeInherited?: boolean;
    includeDocs?: boolean;
    includeNonPublic?: boolean;
    limit?: number;
    offset?: number;
};

export type ApiSymbolMember = {
    name: string;
    qualifiedName: string;
    kind: 'constructor' | 'method' | 'function' | 'property' | 'globalVariable' | 'class' | 'struct' | 'enum';
    declaration: string;
    ownerQualifiedName: string;
    source: 'native' | 'script';
    visibility: TypeMemberVisibility;
    documentation?: string;
    inheritedFrom?: string;
    isMixin?: boolean;
    isCallable?: boolean;
    access?: PropertyAccess | FunctionAccess;
    isAccessor?: true;
    canBlueprintOverride?: true;
    symbolId?: string;
    symbolIdPrefix?: string;
    args?: ApiConstructorArgument[];
    requiredArgumentCount?: number;
};

export type ApiMembersPage = {
    items: ApiSymbolMember[];
    total: number;
    returned: number;
    limit: number;
    offset: number;
    omitted: number;
    truncated: boolean;
};

export type ApiMaterializedMemberOwner = {
    owner: 'namespace' | 'type';
    ownerQualifiedName: string;
    ownerKind: 'namespace' | 'class' | 'struct' | 'enum';
    ownerSource: ApiSearchSource;
    directMembers: ApiSymbolMember[];
    inheritedMembers: ApiSymbolMember[];
};

export type GetAPISymbolMembersResult = {
    ok: true;
    data: {
        requestedName: string;
        found: true;
        symbols: ApiQueryMatch[];
        groups: Array<{
            owner: 'namespace' | 'type';
            ownerQualifiedName: string;
            ownerKind: 'namespace' | 'class' | 'struct' | 'enum';
            ownerSource: ApiSearchSource;
            members: ApiMembersPage;
        }>;
    };
} | {
    ok: false;
    error: {
        code: 'InvalidParams' | 'NotFound';
        message: string;
    };
};

function invalidMembers(message: string) : GetAPISymbolMembersResult
{
    return { ok: false, error: { code: 'InvalidParams', message } };
}

function normalizeStrictSource(value: unknown) : ApiSearchSource
{
    if (value === undefined)
        return 'both';
    if (typeof value != 'string')
        throw new Error("Invalid params. 'source' must be 'native', 'script', or 'both'.");
    let source = value.trim().toLowerCase();
    if (source != 'native' && source != 'script' && source != 'both')
        throw new Error("Invalid params. 'source' must be 'native', 'script', or 'both'.");
    return source as ApiSearchSource;
}

function normalizeStrictBoolean(value: unknown, name: string) : boolean
{
    if (value === undefined)
        return false;
    if (typeof value != 'boolean')
        throw new Error(`Invalid params. '${name}' must be a boolean.`);
    return value;
}

function normalizeMemberCategories(value: unknown) : ApiMemberCategory[]
{
    if (!Array.isArray(value) || value.length == 0)
        throw new Error("Invalid params. 'members' must be a non-empty array.");
    if (value.includes('all'))
    {
        if (value.length != 1)
            throw new Error("Invalid params. 'all' must be used alone in 'members'.");
        return ['callable', 'data', 'constructor', 'type'];
    }
    let order: ApiMemberCategory[] = ['callable', 'data', 'constructor', 'type'];
    for (let item of value)
    {
        if (typeof item != 'string' || !order.includes(item as ApiMemberCategory))
            throw new Error("Invalid params. 'members' supports callable, data, constructor, type, or all.");
    }
    let requested = new Set(value as ApiMemberCategory[]);
    return order.filter((category) => requested.has(category));
}

function normalizeOwnerKind(value: unknown) : ApiMemberOwnerKind
{
    if (value === undefined)
        return 'all';
    if (typeof value != 'string')
        throw new Error("Invalid params. 'ownerKind' must be all, namespace, or type.");
    let owner = value.trim().toLowerCase();
    if (owner != 'all' && owner != 'namespace' && owner != 'type')
        throw new Error("Invalid params. 'ownerKind' must be all, namespace, or type.");
    return owner as ApiMemberOwnerKind;
}

function normalizeMembersLimit(value: unknown) : number
{
    if (value === undefined)
        return 20;
    if (typeof value != 'number' || !Number.isInteger(value) || value < 0 || value > 200)
        throw new Error("Invalid params. 'limit' must be an integer between 0 and 200.");
    return value;
}

function normalizeMembersOffset(value: unknown) : number
{
    if (value === undefined)
        return 0;
    if (typeof value != 'number' || !Number.isInteger(value) || value < 0)
        throw new Error("Invalid params. 'offset' must be a non-negative integer.");
    return value;
}

function sourceOfType(dbType: typedb.DBType) : 'native' | 'script'
{
    return sourceOfDeclaredModule(dbType.declaredModule);
}

function qualifiedTypeLookup(qualifiedName: string) : typedb.DBType | null
{
    let shadowNamespace = typedb.LookupNamespace(null, qualifiedName);
    let shadowedType = shadowNamespace?.getShadowedType();
    if (shadowedType && shadowedType.getQualifiedTypenameInNamespace(null) == qualifiedName)
        return shadowedType;
    let separator = qualifiedName.lastIndexOf('::');
    let namespaceName = separator >= 0 ? qualifiedName.substring(0, separator) : '';
    let typeName = separator >= 0 ? qualifiedName.substring(separator + 2) : qualifiedName;
    let namespace = namespaceName ? typedb.LookupNamespace(null, namespaceName) : typedb.GetRootNamespace();
    return namespace ? typedb.LookupType(namespace, typeName) : null;
}

function memberVisibility(symbol: typedb.DBSymbol) : TypeMemberVisibility
{
    let visibleSymbol = symbol as typedb.DBSymbol & { isPrivate?: boolean; isProtected?: boolean };
    return getTypeVisibility(visibleSymbol.isPrivate === true, visibleSymbol.isProtected === true);
}

function normalizeMemberDocumentation(value: string | null | undefined) : string | undefined
{
    let text = String(value ?? '').trim();
    return text ? text : undefined;
}

function projectCollectedMember(member: CollectedTypeMember) : ApiSymbolMember
{
    let ownerQualifiedName = member.ownerQualifiedName ?? member.declaredIn;
    let kind: ApiSymbolMember['kind'] = member.isAccessor ? 'property' : member.kind;
    let qualifiedName = member.qualifiedName ?? `${ownerQualifiedName}.${member.name}`;
    let symbolIdPrefix = member.kind == 'constructor' && member.symbolId
        ? GetConstructorSymbolIdPrefix(ownerQualifiedName, member.symbolId)
        : undefined;
    return {
        name: member.name,
        qualifiedName,
        kind,
        declaration: member.signature,
        ownerQualifiedName,
        source: member.source,
        visibility: member.visibility,
        ...(member.description ? { documentation: member.description } : {}),
        ...(member.isInherited ? { inheritedFrom: member.declaredIn } : {}),
        ...(member.isMixin ? { isMixin: true } : {}),
        ...(member.isCallable !== undefined ? { isCallable: member.isCallable } : {}),
        ...(member.access !== undefined ? { access: member.access } : {}),
        ...(member.isAccessor ? { isAccessor: true } : {}),
        ...(member.canBlueprintOverride ? { canBlueprintOverride: true } : {}),
        ...(member.symbolId ? { symbolId: member.symbolId } : {}),
        ...(symbolIdPrefix ? { symbolIdPrefix } : {}),
        ...(member.args ? { args: member.args } : {}),
        ...(member.requiredArgumentCount !== undefined ? { requiredArgumentCount: member.requiredArgumentCount } : {})
    };
}

function projectNestedType(dbType: typedb.DBType, ownerQualifiedName: string, includeDocs: boolean) : ApiSymbolMember
{
    let kind: 'class' | 'struct' | 'enum' = dbType.isEnum ? 'enum' : dbType.isStruct ? 'struct' : 'class';
    let qualifiedName = dbType.getQualifiedTypenameInNamespace(null);
    return {
        name: dbType.name,
        qualifiedName,
        kind,
        declaration: `${kind} ${qualifiedName}`,
        ownerQualifiedName,
        source: sourceOfType(dbType),
        visibility: 'public',
        ...(includeDocs && normalizeMemberDocumentation(dbType.documentation) ? { documentation: normalizeMemberDocumentation(dbType.documentation) } : {})
    };
}

function compareMembers(left: ApiSymbolMember, right: ApiSymbolMember) : number
{
    let kindOrder: Record<ApiSymbolMember['kind'], number> = {
        constructor: 0, method: 1, function: 2, property: 3, globalVariable: 4, class: 5, struct: 6, enum: 7
    };
    let kind = kindOrder[left.kind] - kindOrder[right.kind];
    if (kind != 0)
        return kind;
    return `${left.qualifiedName}\u0000${left.source}\u0000${left.declaration}\u0000${left.symbolId ?? ''}`
        .localeCompare(`${right.qualifiedName}\u0000${right.source}\u0000${right.declaration}\u0000${right.symbolId ?? ''}`);
}

function paginateMemberItems(items: ApiSymbolMember[], offset: number, limit: number) : ApiMembersPage
{
    let page = items.slice(offset, offset + limit);
    return {
        items: page,
        total: items.length,
        returned: page.length,
        limit,
        offset,
        omitted: Math.max(0, items.length - page.length),
        truncated: offset + page.length < items.length
    };
}

function collectTypeMembers(
    owner: typedb.DBType,
    source: ApiSearchSource,
    categories: ApiMemberCategory[],
    includeInherited: boolean,
    includeDocs: boolean,
    includeNonPublic: boolean
) : ApiSymbolMember[]
{
    let members = collectTypeMemberRecords(owner, categories, includeInherited, includeDocs, includeNonPublic)
        .map(projectCollectedMember);
    members = members.filter((member) =>
    {
        if (member.kind == 'constructor')
            return categories.includes('constructor');
        if (member.isAccessor)
            return categories.includes('data');
        if (member.kind == 'method' || member.kind == 'function')
            return member.isCallable === false ? categories.includes('data') : categories.includes('callable');
        return member.kind == 'property' || member.kind == 'globalVariable' ? categories.includes('data') : false;
    });
    if (categories.includes('type'))
    {
        owner.forEachSymbol((symbol) =>
        {
            if (symbol instanceof typedb.DBType)
                members.push(projectNestedType(symbol, owner.getQualifiedTypenameInNamespace(null), includeDocs));
        }, false);
    }
    return members
        .filter((member) => source == 'both' || member.source == source)
        .sort(compareMembers);
}

function collectNamespaceMembers(
    namespace: typedb.DBNamespace,
    ownerQualifiedName: string,
    source: ApiSearchSource,
    categories: ApiMemberCategory[],
    includeDocs: boolean,
    includeNonPublic: boolean
) : ApiSymbolMember[]
{
    let members = new Array<ApiSymbolMember>();
    namespace.forEachSymbol((symbol) =>
    {
        if (symbol instanceof typedb.DBMethod)
        {
            if (!matchesSearchSource(symbol.declaredModule, source))
                return;
            let visibility = memberVisibility(symbol);
            if (!includeNonPublic && visibility != 'public')
                return;
            if (symbol.isConstructor)
            {
                if (!categories.includes('constructor'))
                    return;
                let constructor = ProjectConstructor(symbol);
                if (!constructor)
                    return;
                let symbolIdPrefix = GetConstructorSymbolIdPrefix(constructor.ownerQualifiedName, constructor.symbolId);
                members.push({
                    name: constructor.name,
                    qualifiedName: constructor.qualifiedName,
                    kind: 'constructor',
                    declaration: constructor.declaration,
                    ownerQualifiedName: constructor.ownerQualifiedName,
                    source: constructor.source,
                    visibility,
                    ...(includeDocs && constructor.documentation ? { documentation: constructor.documentation } : {}),
                    isCallable: true,
                    symbolId: constructor.symbolId,
                    ...(symbolIdPrefix ? { symbolIdPrefix } : {}),
                    args: constructor.args,
                    requiredArgumentCount: constructor.requiredArgumentCount
                });
                return;
            }
            let isCallable = symbol.isCallable !== false;
            let isAccessor = symbol.isProperty === true;
            if (isAccessor ? !categories.includes('data') : isCallable ? !categories.includes('callable') : !categories.includes('data'))
                return;
            let namespaceName = namespace.isRootNamespace() ? '' : namespace.getQualifiedNamespace();
            let accessor = getPropertyAccessorInfo(symbol);
            members.push({
                name: symbol.name,
                qualifiedName: namespaceName ? `${namespaceName}::${symbol.name}` : symbol.name,
                kind: isAccessor ? 'property' : 'function',
                declaration: buildMethodSignature(symbol, '', isAccessor, accessor.accessorKind ?? null, accessor.propertyName ?? null),
                ownerQualifiedName,
                source: symbol.declaredModule ? 'script' : 'native',
                visibility,
                ...(includeDocs && normalizeMemberDocumentation(symbol.findAvailableDocumentation()) ? { documentation: normalizeMemberDocumentation(symbol.findAvailableDocumentation()) } : {}),
                ...(symbol.isMixin ? { isMixin: true } : {}),
                isCallable,
                access: isAccessor
                    ? (accessor.accessorKind ? accessorPropertyAccess(symbol.access, accessor.accessorKind) : unknownPropertyAccess())
                    : symbol.access ?? unknownFunctionAccess(),
                ...(isAccessor ? { isAccessor: true } : {}),
                ...(isNativeBlueprintOverrideTarget(symbol) ? { canBlueprintOverride: true } : {})
            });
            return;
        }
        if (symbol instanceof typedb.DBProperty)
        {
            if (!categories.includes('data') || !matchesSearchSource(symbol.declaredModule, source))
                return;
            let visibility = memberVisibility(symbol);
            if (!includeNonPublic && visibility != 'public')
                return;
            let namespaceName = namespace.isRootNamespace() ? '' : namespace.getQualifiedNamespace();
            members.push({
                name: symbol.name,
                qualifiedName: namespaceName ? `${namespaceName}::${symbol.name}` : symbol.name,
                kind: 'globalVariable',
                declaration: symbol.format(namespaceName ? `${namespaceName}::` : ''),
                ownerQualifiedName,
                source: symbol.declaredModule ? 'script' : 'native',
                visibility,
                ...(includeDocs && normalizeMemberDocumentation(symbol.documentation) ? { documentation: normalizeMemberDocumentation(symbol.documentation) } : {}),
                isCallable: false,
                // Global variables keep their existing public contract; the
                // access v1 payload is limited to property/method/function.
            });
            return;
        }
        if (symbol instanceof typedb.DBType && categories.includes('type') && matchesSearchSource(symbol.declaredModule, source))
            members.push(projectNestedType(symbol, ownerQualifiedName, includeDocs));
    });
    return members.sort(compareMembers);
}

export function ExportAPIMaterializedMemberOwners() : ApiMaterializedMemberOwner[]
{
    let result: ApiMaterializedMemberOwner[] = [];
    let categories: ApiMemberCategory[] = ['callable', 'data', 'constructor', 'type'];
    for (let [, namespace] of typedb.GetAllNamespaces())
    {
        if (namespace.isRootNamespace() || isInternalApiSymbolName(namespace.name) || isNamespaceApiEmpty(namespace))
            continue;
        let hasNative = namespace.declarations.some((declaration) => !declaration.declaredModule);
        let hasScript = namespace.declarations.some((declaration) => !!declaration.declaredModule);
        let ownerSource: ApiSearchSource = hasNative && hasScript ? 'both' : hasScript ? 'script' : 'native';
        let ownerQualifiedName = namespace.getQualifiedNamespace();
        result.push({
            owner: 'namespace',
            ownerQualifiedName,
            ownerKind: 'namespace',
            ownerSource,
            directMembers: collectNamespaceMembers(namespace, ownerQualifiedName, 'both', categories, true, true),
            inheritedMembers: collectNamespaceMembers(namespace, ownerQualifiedName, 'both', categories, true, true),
        });
    }
    for (let [, dbType] of typedb.GetAllTypesById())
    {
        if (dbType.isPrimitive || dbType.isDelegate || dbType.isEvent || dbType.isTemplateInstantiation)
            continue;
        let ownerQualifiedName = dbType.getQualifiedTypenameInNamespace(null);
        let ownerKind: 'class' | 'struct' | 'enum' = dbType.isEnum ? 'enum' : dbType.isStruct ? 'struct' : 'class';
        result.push({
            owner: 'type',
            ownerQualifiedName,
            ownerKind,
            ownerSource: sourceOfType(dbType),
            directMembers: collectTypeMembers(dbType, 'both', categories, false, true, true),
            inheritedMembers: collectTypeMembers(dbType, 'both', categories, true, true, true),
        });
    }
    return result.sort((left, right) =>
        `${left.ownerQualifiedName}\u0000${left.ownerSource}\u0000${left.owner}`
            .localeCompare(`${right.ownerQualifiedName}\u0000${right.ownerSource}\u0000${right.owner}`));
}

export function GetAPISymbolMembers(payload: unknown) : GetAPISymbolMembersResult
{
    if (!payload || typeof payload != 'object' || Array.isArray(payload))
        return invalidMembers('Invalid params. Provide a member query object.');
    let record = payload as Record<string, unknown>;
    let name = typeof record.name == 'string' ? record.name.trim() : '';
    if (!name)
        return invalidMembers("Invalid params. 'name' must be a non-empty string.");
    try
    {
        let source = normalizeStrictSource(record.source);
        let ownerKind = normalizeOwnerKind(record.ownerKind);
        let categories = normalizeMemberCategories(record.members);
        let includeInherited = normalizeStrictBoolean(record.includeInherited, 'includeInherited');
        let includeDocs = normalizeStrictBoolean(record.includeDocs, 'includeDocs');
        let includeNonPublic = normalizeStrictBoolean(record.includeNonPublic, 'includeNonPublic');
        let limit = normalizeMembersLimit(record.limit);
        let offset = normalizeMembersOffset(record.offset);
        if (categories.length == 1 && categories[0] == 'constructor' && ownerKind == 'namespace')
            return invalidMembers('Invalid params. constructor members require a type owner.');

        let exact = GetAPIExactSymbols({ name, source: 'both', includeDocs: false, includeNonPublic: true });
        if ('error' in exact)
            return exact.error.code == 'InvalidParams' ? invalidMembers(exact.error.message) : { ok: false, error: exact.error };
        let namespaceExact = source == 'both'
            ? exact
            : GetAPIExactSymbols({ name, source, includeDocs: false, includeNonPublic: true });
        if ('error' in namespaceExact && ownerKind == 'namespace')
            return namespaceExact.error.code == 'InvalidParams'
                ? invalidMembers(namespaceExact.error.message)
                : { ok: false, error: namespaceExact.error };
        let namespaceOwnerKeys = new Set('error' in namespaceExact
            ? []
            : namespaceExact.data.symbols
                .filter((symbol) => symbol.kind == 'namespace')
                .map((symbol) => `${symbol.qualifiedName}\u0000${symbol.source}`));
        let owners = exact.data.symbols.filter((symbol) =>
            (ownerKind != 'type'
                && symbol.kind == 'namespace'
                && !(categories.length == 1 && categories[0] == 'constructor')
                && namespaceOwnerKeys.has(`${symbol.qualifiedName}\u0000${symbol.source}`))
            || (ownerKind != 'namespace' && (symbol.kind == 'class' || symbol.kind == 'struct' || symbol.kind == 'enum'))
        );
        if (owners.length == 0)
        {
            if ('error' in namespaceExact && namespaceExact.error.code != 'InvalidParams')
                return { ok: false, error: namespaceExact.error };
            return invalidMembers(`API member target is not an eligible namespace or type owner: ${name}`);
        }
        let qualifiedNames = [...new Set(owners.map((owner) => owner.qualifiedName))];
        if (qualifiedNames.length > 1)
        {
            return { ok: true, data: { requestedName: name, found: true, symbols: owners, groups: [] } };
        }

        let groups: Extract<GetAPISymbolMembersResult, { ok: true }>['data']['groups'] = [];
        for (let owner of owners)
        {
            if (owner.kind == 'namespace')
            {
                let namespace = typedb.LookupNamespace(null, owner.qualifiedName);
                if (!namespace)
                    continue;
                let items = collectNamespaceMembers(namespace, owner.qualifiedName, source, categories, includeDocs, includeNonPublic);
                groups.push({
                    owner: 'namespace',
                    ownerQualifiedName: owner.qualifiedName,
                    ownerKind: 'namespace',
                    ownerSource: owner.source,
                    members: paginateMemberItems(items, offset, limit)
                });
                continue;
            }
            let dbType = qualifiedTypeLookup(owner.qualifiedName);
            if (!dbType)
                continue;
            let items = collectTypeMembers(dbType, source, categories, includeInherited, includeDocs, includeNonPublic);
            groups.push({
                owner: 'type',
                ownerQualifiedName: owner.qualifiedName,
                ownerKind: owner.kind as 'class' | 'struct' | 'enum',
                ownerSource: owner.source,
                members: paginateMemberItems(items, offset, limit)
            });
        }
        if (groups.length != owners.length)
            return { ok: false, error: { code: 'NotFound', message: `API member owner could not be resolved: ${name}; resolved ${groups.map((group) => group.owner).join(',')} from ${owners.map((owner) => owner.kind).join(',')}.` } };
        return { ok: true, data: { requestedName: name, found: true, symbols: owners, groups } };
    }
    catch (error)
    {
        return invalidMembers(error instanceof Error ? error.message : String(error));
    }
}

export type GetAPIClassHierarchyParams = {
    name: string;
    source?: ApiSearchSource;
    maxSuperDepth?: number;
    maxSubDepth?: number;
    maxSubBreadth?: number;
};

type ApiHierarchySource = ReturnType<typeof getScriptClassSourceInfo>;

export type GetAPIClassHierarchyResult = {
    ok: true;
    data: {
        requestedName: string;
        found: true;
        root: string;
        qualifiedName: string;
        superClasses: string[];
        derivedByParent: Record<string, string[]>;
        sourceByClass: Record<string, ApiHierarchySource>;
        limits: { maxSuperDepth: number; maxSubDepth: number; maxSubBreadth: number };
        truncated: { superDepth: boolean; subDepth: boolean; subBreadth: boolean };
        omitted: { superDepth: number; subDepth: number; subBreadth: number; subBreadthByClass: Record<string, number> };
    };
} | {
    ok: false;
    error: { code: 'InvalidParams' | 'NotFound'; message: string };
};

function normalizeHierarchyLimit(value: unknown, fallback: number, name: string) : number
{
    if (value === undefined)
        return fallback;
    if (typeof value != 'number' || !Number.isInteger(value) || value < 0)
        throw new Error(`Invalid params. '${name}' must be a non-negative integer.`);
    return value;
}

function hierarchyId(dbType: typedb.DBType) : string
{
    return `${sourceOfType(dbType)}:${dbType.getQualifiedTypenameInNamespace(null)}`;
}

export function GetAPIClassHierarchy(payload: unknown) : GetAPIClassHierarchyResult
{
    if (!payload || typeof payload != 'object' || Array.isArray(payload))
        return { ok: false, error: { code: 'InvalidParams', message: 'Invalid params. Provide a hierarchy query object.' } };
    let record = payload as Record<string, unknown>;
    let name = typeof record.name == 'string' ? record.name.trim() : '';
    if (!name)
        return { ok: false, error: { code: 'InvalidParams', message: "Invalid params. 'name' must be a non-empty string." } };
    try
    {
        let source = normalizeStrictSource(record.source);
        let maxSuperDepth = normalizeHierarchyLimit(record.maxSuperDepth, 3, 'maxSuperDepth');
        let maxSubDepth = normalizeHierarchyLimit(record.maxSubDepth, 2, 'maxSubDepth');
        let maxSubBreadth = normalizeHierarchyLimit(record.maxSubBreadth, 10, 'maxSubBreadth');
        let exact = GetAPIExactSymbols({ name, kind: 'class', source, includeNonPublic: true });
        if ('error' in exact)
            return { ok: false, error: exact.error };
        let qualifiedNames = [...new Set(exact.data.symbols.map((symbol) => symbol.qualifiedName))];
        if (qualifiedNames.length != 1)
            return { ok: false, error: { code: 'InvalidParams', message: `Ambiguous class name: ${name}. Use a qualified name.` } };
        let root = qualifiedTypeLookup(qualifiedNames[0]);
        if (!root || !isClassType(root))
            return { ok: false, error: { code: 'InvalidParams', message: `Type is not a concrete class: ${name}` } };
        if (source != 'both' && sourceOfType(root) != source)
            return { ok: false, error: { code: 'NotFound', message: `Class not found for source '${source}': ${name}` } };

        let allTypes = [...typedb.GetAllTypesById().values()].filter(isClassType);
        let childrenByParent = new Map<typedb.DBType, typedb.DBType[]>();
        for (let candidate of allTypes)
        {
            let parent = resolveHierarchySuperType(candidate);
            if (!parent)
                continue;
            let bucket = childrenByParent.get(parent);
            if (!bucket)
            {
                bucket = [];
                childrenByParent.set(parent, bucket);
            }
            if (!bucket.includes(candidate))
                bucket.push(candidate);
        }
        for (let bucket of childrenByParent.values())
            bucket.sort((left, right) => hierarchyId(left).localeCompare(hierarchyId(right)));

        let sourceByClass: Record<string, ApiHierarchySource> = {};
        sourceByClass[hierarchyId(root)] = getScriptClassSourceInfo(root);
        let supers = new Array<string>();
        let superSeen = new Set<typedb.DBType>([root]);
        let current = root;
        for (let depth = 0; depth < maxSuperDepth; depth += 1)
        {
            let parent = resolveHierarchySuperType(current);
            if (!parent || superSeen.has(parent))
                break;
            superSeen.add(parent);
            let id = hierarchyId(parent);
            supers.push(id);
            sourceByClass[id] = getScriptClassSourceInfo(parent);
            current = parent;
        }
        let nextSuper = resolveHierarchySuperType(current);
        let superTruncated = !!nextSuper && !superSeen.has(nextSuper);

        let derivedByParent: Record<string, string[]> = {};
        let breadthByClass: Record<string, number> = {};
        let visited = new Set<typedb.DBType>([root]);
        let depthTruncated = false;
        let visit = (parent: typedb.DBType, depth: number) =>
        {
            let children = (childrenByParent.get(parent) ?? []).filter((child) => !visited.has(child));
            if (depth <= 0)
            {
                if (children.length > 0)
                    depthTruncated = true;
                return;
            }
            let parentId = hierarchyId(parent);
            if (children.length > maxSubBreadth)
                breadthByClass[parentId] = children.length - maxSubBreadth;
            let kept = children.slice(0, maxSubBreadth);
            if (kept.length > 0)
                derivedByParent[parentId] = [];
            for (let child of kept)
            {
                visited.add(child);
                let childId = hierarchyId(child);
                derivedByParent[parentId].push(childId);
                sourceByClass[childId] = getScriptClassSourceInfo(child);
                visit(child, depth - 1);
            }
        };
        visit(root, maxSubDepth);
        let breadthOmitted = Object.values(breadthByClass).reduce((sum, count) => sum + count, 0);
        let rootId = hierarchyId(root);
        return {
            ok: true,
            data: {
                requestedName: name,
                found: true,
                root: rootId,
                qualifiedName: root.getQualifiedTypenameInNamespace(null),
                superClasses: supers,
                derivedByParent,
                sourceByClass,
                limits: { maxSuperDepth, maxSubDepth, maxSubBreadth },
                truncated: { superDepth: superTruncated, subDepth: depthTruncated, subBreadth: breadthOmitted > 0 },
                omitted: {
                    superDepth: superTruncated ? 1 : 0,
                    subDepth: depthTruncated ? 1 : 0,
                    subBreadth: breadthOmitted,
                    subBreadthByClass: breadthByClass
                }
            }
        };
    }
    catch (error)
    {
        return { ok: false, error: { code: 'InvalidParams', message: error instanceof Error ? error.message : String(error) } };
    }
}

function isNamespaceApiEmpty(nsType : typedb.DBNamespace) : boolean
{
    if (nsType.childNamespaces.size != 0)
        return false;
    if (nsType.symbols.size != 0)
        return false;
    return true;
}

function shouldSkipApiFunction(func : typedb.DBMethod) : boolean
{
    return false;
}

function isInternalApiSymbolName(name: string | undefined | null) : boolean
{
    return typeof name == "string" && name.startsWith("__");
}
