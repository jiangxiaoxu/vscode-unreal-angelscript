import * as scriptfiles from './as_parser';
import * as typedb from './database';
import * as documentation from './documentation';

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
                if (childNamespace.isShadowingType())
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

export function GetAPISearch(filter: string): any
{
    let list: any[] = [];
    let phraseGroups: Array<Array<string>> = [];
    let tokenRegex = /::|\.|[A-Za-z0-9_]+/g;
    for (let rawGroup of filter.split("|"))
    {
        let group = new Array<string>();
        let matches = rawGroup.match(tokenRegex);
        if (matches)
        {
            for (let token of matches)
            {
                if (token == "." || token == "::")
                    group.push(token);
                else
                    group.push(token.toLowerCase());
            }
        }

        if (group.length > 0)
            phraseGroups.push(group);
    }

    if (phraseGroups.length == 0)
        return [];

    let groupMatches = function (name: string, group: Array<string>)
    {
        if (group.length == 0)
            return false;

        let lowerName = name.toLowerCase();
        let searchIndex = 0;
        for (let token of group)
        {
            if (token == "." || token == "::")
            {
                let matchIndex = name.indexOf(token, searchIndex);
                if (matchIndex == -1)
                    return false;
                searchIndex = matchIndex + token.length;
                continue;
            }

            let matchIndex = lowerName.indexOf(token, searchIndex);
            if (matchIndex == -1)
                return false;
            searchIndex = matchIndex + token.length;
        }

        return true;
    }

    let canComplete = function (name: string)
    {
        for (let group of phraseGroups)
        {
            if (groupMatches(name, group))
                return true;
        }
        return false;
    }

    let isWordChar = function (char: string) : boolean
    {
        let code = char.charCodeAt(0);
        return (code >= 48 && code <= 57)
            || (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || code == 95;
    }

    let isUpper = function (char: string) : boolean
    {
        let code = char.charCodeAt(0);
        return code >= 65 && code <= 90;
    }

    let isLower = function (char: string) : boolean
    {
        let code = char.charCodeAt(0);
        return code >= 97 && code <= 122;
    }

    let scoreUppercase = function (name: string, index: number, length: number) : number
    {
        let score = 0;
        let end = Math.min(name.length, index + length);
        for (let i = index; i < end; ++i)
        {
            if (isUpper(name[i]))
                score += 25;
        }
        if (index < name.length && isUpper(name[index]))
            score += 40;
        return score;
    }

    let isBoundary = function (name: string, index: number) : boolean
    {
        if (index <= 0)
            return true;
        let prev = name[index - 1];
        let curr = name[index];
        if (!isWordChar(prev))
            return true;
        if (isLower(prev) && isUpper(curr))
            return true;
        return false;
    }

    let scoreToken = function (name: string, index: number, length: number) : number
    {
        let score = 0;
        if (index == 0)
            score += 200;
        if (isBoundary(name, index))
            score += 150;
        score += scoreUppercase(name, index, length);
        score += Math.max(0, 100 - index);
        score += Math.max(0, 20 - length);
        return score;
    }

    let scoreGroup = function (name: string, lowerName: string, group: Array<string>) : number
    {
        if (group.length == 0)
            return -1;

        let searchIndex = 0;
        let score = 0;
        for (let token of group)
        {
            if (token == "." || token == "::")
            {
                let matchIndex = name.indexOf(token, searchIndex);
                if (matchIndex == -1)
                    return -1;
                score += token == "::" ? 60 : 40;
                searchIndex = matchIndex + token.length;
                continue;
            }

            let matchIndex = lowerName.indexOf(token, searchIndex);
            if (matchIndex == -1)
                return -1;
            score += scoreToken(name, matchIndex, token.length);
            searchIndex = matchIndex + token.length;
        }

        if (group.length == 1 && lowerName == group[0])
            score += 300;

        score += Math.max(0, 50 - name.length);
        return score;
    }

    let scoreName = function (name: string) : number
    {
        if (!name)
            return -1;

        let lowerName = name.toLowerCase();
        let best = -1;
        for (let group of phraseGroups)
        {
            let groupScore = scoreGroup(name, lowerName, group);
            if (groupScore > best)
                best = groupScore;
        }
        return best;
    }

    let seenIds = new Set<string>();
    let typeResults: any[] = [];

    let searchType = function (type: typedb.DBType | typedb.DBNamespace)
    {
        let typePrefix: string = "";
        let typeMatches = false;
        if (type instanceof typedb.DBNamespace)
        {
            for (let [_, childNamespace] of type.childNamespaces)
            {
                if (childNamespace.isShadowingType())
                    continue;

                searchType(childNamespace);
            }

            if (!type.isRootNamespace())
            {
                typePrefix = type.getQualifiedNamespace() + "::";
                // Check both the namespace name and the full qualified namespace (including "::")
                typeMatches = canComplete(type.name) || canComplete(typePrefix);
            }
        }
        else
        {
            typePrefix = type.getQualifiedTypenameInNamespace(null) + ".";
            // Check both the type name and the full qualified type name (including ".")
            typeMatches = canComplete(type.name) || canComplete(typePrefix);
        }

        if (!(type instanceof typedb.DBNamespace))
        {
            if (typeMatches && !type.isDelegate && !type.isEvent && !type.isPrimitive && !type.isTemplateInstantiation)
            {
                let displayName = type.name;
                if (type.isTemplateType() && type.templateSubTypes && type.templateSubTypes.length > 0)
                    displayName = typedb.FormatTemplateTypename(type.name, type.templateSubTypes);

                let typeNamespace = type.namespace && !type.namespace.isRootNamespace()
                    ? type.namespace.getQualifiedNamespace()
                    : "";

                let typeKind = "class";
                if (type.isEnum)
                    typeKind = "enum";
                else if (type.isStruct)
                    typeKind = "struct";

                let uniqueId = ["type", type.name, typeNamespace].join("|");
                if (!seenIds.has(uniqueId))
                {
                    seenIds.add(uniqueId);
                    typeResults.push({
                        "type": "type",
                        "label": displayName,
                        "id": uniqueId,
                        "data": ["type", type.name, typeNamespace, typeKind],
                    });
                }
            }
        }

        let getConstructorOwnerType = function (symbol: typedb.DBMethod): typedb.DBType | null
        {
            if (symbol.containingType)
                return symbol.containingType;

            if (symbol.namespace)
            {
                let shadowed = symbol.namespace.getShadowedType();
                if (shadowed)
                    return shadowed;
            }

            if (symbol.returnType)
            {
                let lookupNamespace = symbol.namespace;
                if (lookupNamespace && lookupNamespace.isRootNamespace())
                    lookupNamespace = null;
                let found = typedb.LookupType(lookupNamespace, symbol.returnType);
                if (found)
                    return found;
                found = typedb.GetTypeByName(symbol.returnType);
                if (found)
                    return found;
            }

            if (symbol.name)
            {
                let found = typedb.GetTypeByName(symbol.name);
                if (found)
                    return found;
            }

            return null;
        }

        type.forEachSymbol(function (symbol: typedb.DBSymbol)
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (symbol.isConstructor && (!symbol.args || symbol.args.length == 0))
                    return;
                if (symbol.isConstructor && symbol.args && symbol.args.length == 1)
                    return;
                if (symbol.isConstructor)
                {
                    let ctorType = getConstructorOwnerType(symbol);
                    if (ctorType && (ctorType.isDelegate || ctorType.isEvent))
                        return;
                }
                if (symbol.name.startsWith("op"))
                    return;
                // Also check the full qualified name (prefix + symbol name)
                let fullName = typePrefix + symbol.name;
                if (typeMatches || canComplete(symbol.name) || canComplete(fullName))
                {
                    let symbol_id;
                    if (symbol.containingType)
                    {
                        let methodNamespace = symbol.containingType.namespace
                            ? symbol.containingType.namespace.getQualifiedNamespace()
                            : "";
                        let methodArgs = symbol.args ? symbol.args.map((arg) => arg.typename) : [];
                        symbol_id = ["method", symbol.containingType.name, symbol.name, symbol.id, methodNamespace, methodArgs];
                    }
                    else if (symbol.namespace && !symbol.namespace.isRootNamespace())
                    {
                        let methodArgs = symbol.args ? symbol.args.map((arg) => arg.typename) : [];
                        symbol_id = ["function", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name, symbol.id, methodArgs];
                    }
                    else
                    {
                        let methodArgs = symbol.args ? symbol.args.map((arg) => arg.typename) : [];
                        symbol_id = ["function", symbol.name, symbol.id, methodArgs];
                    }

                    let label = typePrefix + symbol.name + "()";
                    if (symbol.isConstructor)
                    {
                        let ctorArgs = "";
                        if (symbol.args && symbol.args.length > 0)
                        {
                            ctorArgs = symbol.args.map((arg) =>
                            {
                                if (arg.name)
                                    return arg.typename + " " + arg.name;
                                return arg.typename;
                            }).join(", ");
                        }
                        let ctorTypeName = "";
                        let ctorType = getConstructorOwnerType(symbol);
                        if (ctorType)
                        {
                            ctorTypeName = ctorType.getQualifiedTypenameInNamespace(null);
                        }
                        else if (symbol.returnType)
                        {
                            if (symbol.namespace && !symbol.namespace.isRootNamespace())
                                ctorTypeName = symbol.namespace.getQualifiedNamespace() + "::" + symbol.returnType;
                            else
                                ctorTypeName = symbol.returnType;
                        }
                        else if (symbol.name)
                        {
                            ctorTypeName = symbol.name;
                        }

                        if (!ctorTypeName && typePrefix)
                        {
                            if (typePrefix.endsWith("."))
                                ctorTypeName = typePrefix.substring(0, typePrefix.length - 1);
                            else if (typePrefix.endsWith("::"))
                                ctorTypeName = typePrefix.substring(0, typePrefix.length - 2);
                        }
                        label = "<ctor>" + ctorTypeName + "(" + ctorArgs + ")";
                    }
                    else if (symbol.isMixin)
                    {
                        label = symbol.args[0].typename + "." + symbol.name + "()";
                    }

                    let uniqueId = symbol_id.join("|");
                    if (!seenIds.has(uniqueId))
                    {
                        seenIds.add(uniqueId);
                        list.push({
                            "type": "function",
                            "label": label,
                            "id": symbol.id.toString(),
                            "data": symbol_id,
                        });
                    }
                }
            }
            else if (symbol instanceof typedb.DBProperty)
            {
                // Also check the full qualified name (prefix + symbol name)
                let fullName = typePrefix + symbol.name;
                if (typeMatches || canComplete(symbol.name) || canComplete(fullName))
                {
                    let symbol_id;
                    if (symbol.containingType)
                        symbol_id = ["property", symbol.containingType.name, symbol.name];
                    else if (symbol.namespace && !symbol.namespace.isRootNamespace())
                        symbol_id = ["global", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name];
                    else
                        symbol_id = ["global", symbol.name];

                    let uniqueId = symbol_id.join("|");
                    if (!seenIds.has(uniqueId))
                    {
                        seenIds.add(uniqueId);
                        list.push({
                            "type": "property",
                            "label": typePrefix + symbol.name,
                            "id": typePrefix + symbol.name,
                            "data": symbol_id,
                        });
                    }
                }
            }
            else if (symbol instanceof typedb.DBType)
            {
                if (!symbol.isTemplateInstantiation && !symbol.isTemplateType() && !symbol.isDelegate && !symbol.isEvent)
                    searchType(symbol);
            }
        }, false);
    }

    searchType(typedb.GetRootNamespace());

    if (typeResults.length > 0)
        list = typeResults.concat(list);

    let getSearchName = function (item: any) : string
    {
        if (item && item.type == "type" && Array.isArray(item.data))
        {
            let name = item.data[1] as string;
            let typeNamespace = item.data[2] as string;
            if (typeNamespace)
                return typeNamespace + "::" + name;
            return name;
        }
        return item && item.label ? String(item.label) : "";
    }

    let scoreCache = new Map<any, number>();
    let getItemScore = function (item: any) : number
    {
        if (scoreCache.has(item))
            return scoreCache.get(item);
        let score = scoreName(getSearchName(item));
        scoreCache.set(item, score);
        return score;
    }

    let getTypeOrder = function (item: any) : number
    {
        let kind = item && item.data ? item.data[0] : "";
        if (kind == "type")
            return 0;
        if (kind == "function")
            return 1;
        if (kind == "property")
            return 2;
        return 3;
    }

    list.sort(function (a, b)
    {
        let orderA = getTypeOrder(a);
        let orderB = getTypeOrder(b);
        if (orderA != orderB)
            return orderA - orderB;

        let scoreA = getItemScore(a);
        let scoreB = getItemScore(b);
        if (scoreA != scoreB)
            return scoreB - scoreA;

        if (a.label < b.label)
            return -1;
        else if (a.label > b.label)
            return 1;

        return 0;
    });

    return list;
}
