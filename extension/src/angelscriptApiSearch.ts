import { LanguageClient } from 'vscode-languageclient/node';
import { GetAPIDetailsRequest, GetAPISearchRequest } from './apiRequests';

export type AngelscriptSearchParams = {
    query: string;
    limit?: number;
    includeDetails?: boolean;
};

export type ApiResultItem = {
    label: string;
    type?: string;
    data?: unknown;
    details?: string;
};

export type ApiResponsePayload = {
    query: string;
    total: number;
    returned: number;
    truncated: boolean;
    items: ApiResultItem[];
};

export async function buildSearchPayload(
    client: LanguageClient,
    params: AngelscriptSearchParams,
    isCancelled: () => boolean
): Promise<ApiResponsePayload> {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const limit = typeof params.limit === 'number'
        ? Math.min(Math.max(Math.floor(params.limit), 1), 1000)
        : 500;
    const includeDetails = params.includeDetails !== false;

    if (!query) {
        return {
            query,
            total: 0,
            returned: 0,
            truncated: false,
            items: []
        };
    }

    const results = await client.sendRequest(GetAPISearchRequest, query);
    if (!results || results.length === 0) {
        return {
            query,
            total: 0,
            returned: 0,
            truncated: false,
            items: []
        };
    }

    const items = results.slice(0, limit);
    const payload: ApiResponsePayload = {
        query,
        total: results.length,
        returned: items.length,
        truncated: results.length > items.length,
        items: items.map((item: any) => ({
            label: item.label,
            type: item.type ?? undefined,
            data: item.data ?? undefined
        }))
    };

    if (!includeDetails || payload.items.length === 0) {
        return payload;
    }

    if (isCancelled()) {
        return payload;
    }

    const concurrencyLimit = 10;
    const allDetails: Array<{ index: number; details?: string }> = [];
    let nextIndex = 0;
    let activeCount = 0;
    let cancelled = false;
    const totalItems = payload.items.length;

    await new Promise<void>((resolveAll) => {
        const startNext = () => {
            if (isCancelled()) {
                cancelled = true;
                if (activeCount === 0) {
                    resolveAll();
                }
                return;
            }

            while (nextIndex < totalItems && activeCount < concurrencyLimit) {
                const currentIndex = nextIndex;
                const item = payload.items[currentIndex];
                const itemData = item.data;
                nextIndex += 1;
                activeCount += 1;

                client.sendRequest(GetAPIDetailsRequest, itemData)
                    .then((details: string) => {
                        allDetails.push({ index: currentIndex, details });
                    })
                    .catch(() => {
                        allDetails.push({ index: currentIndex, details: undefined });
                    })
                    .finally(() => {
                        activeCount -= 1;
                        if ((nextIndex >= totalItems || cancelled) && activeCount === 0) {
                            resolveAll();
                        } else {
                            startNext();
                        }
                    });
            }
        };

        startNext();
    });

    for (const detail of allDetails) {
        payload.items[detail.index].details = detail.details;
    }

    return payload;
}
