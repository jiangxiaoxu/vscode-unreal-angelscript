import { RequestType, RequestType0, TextDocumentPositionParams } from 'vscode-languageclient/node';
import { SearchSource } from './angelscriptApiSearch';

export const GetModuleForSymbolRequest = new RequestType<TextDocumentPositionParams, string, void>('angelscript/getModuleForSymbol');
export const GetUnrealConnectionStatusRequest = new RequestType0<boolean, void>('angelscript/getUnrealConnectionStatus');
export const ProvideInlineValuesRequest = new RequestType<TextDocumentPositionParams, any[], void>('angelscript/provideInlineValues');
export const GetAPIRequest = new RequestType<any, any[], void>('angelscript/getAPI');
export const GetAPIDetailsRequest = new RequestType<any, string, void>('angelscript/getAPIDetails');
export const GetAPIDetailsBatchRequest = new RequestType<any[], string[], void>('angelscript/getAPIDetailsBatch');
export type GetTypeMembersParams = {
    name: string;
    namespace?: string;
    includeInherited?: boolean;
    includeDocs?: boolean;
    kinds?: 'both' | 'method' | 'property';
};
export type TypeMemberVisibility = 'public' | 'protected' | 'private';
export type TypeMemberInfo = {
    kind: 'method' | 'property';
    name: string;
    signature: string;
    description: string;
    declaredIn: string;
    declaredInKind: 'type' | 'namespace';
    isInherited: boolean;
    isMixin: boolean;
    isAccessor: boolean;
    accessorKind?: 'get' | 'set';
    propertyName?: string;
    visibility: TypeMemberVisibility;
};
export type GetTypeMembersResult = {
    ok: true;
    type: {
        name: string;
        namespace: string;
        qualifiedName: string;
    };
    members: TypeMemberInfo[];
} | {
    ok: false;
    error: {
        code: 'NotFound' | 'InvalidParams';
        message: string;
    };
};
export const GetTypeMembersRequest = new RequestType<GetTypeMembersParams, GetTypeMembersResult, void>('angelscript/getTypeMembers');
export type GetAPISearchParams = {
    filter: string;
    source?: SearchSource;
};
export const GetAPISearchRequest = new RequestType<GetAPISearchParams, any[], void>('angelscript/getAPISearch');
export type ResolveSymbolAtPositionParams = {
    uri: string;
    position: {
        line: number;
        character: number;
    };
    includeDocumentation?: boolean;
};

export type ResolveSymbolAtPositionResult = {
    ok: true;
    symbol: {
        kind: string;
        name: string;
        signature: string;
        definition?: {
            uri: string;
            startLine: number;
            endLine: number;
        };
        doc?: {
            format: 'markdown' | 'plaintext';
            text: string;
        };
    };
} | {
    ok: false;
    error: {
        code: 'NotFound' | 'NotReady' | 'InvalidParams' | 'Unavailable';
        message: string;
        retryable?: boolean;
        hint?: string;
    };
};

export const ResolveSymbolAtPositionRequest = new RequestType<ResolveSymbolAtPositionParams, ResolveSymbolAtPositionResult, void>('angelscript/resolveSymbolAtPosition');
