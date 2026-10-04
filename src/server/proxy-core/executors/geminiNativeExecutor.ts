import { resolveRuntimeRequestUrl } from '../providers/requestUrl.js';
import { performFetch, type RuntimeExecutor } from './types.js';

// Retry ownership remains with endpointFlow and the surface retry budget.
export const geminiNativeExecutor: RuntimeExecutor = {
  dispatch(input) {
    return performFetch(input, input.request, input.targetUrl || resolveRuntimeRequestUrl(input.siteUrl, input.request));
  },
};
