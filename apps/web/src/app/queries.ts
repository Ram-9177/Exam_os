import { QueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { TenantInfo } from '@/lib/auth';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => (err instanceof ApiError ? err.status >= 500 && count < 2 : count < 2),
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
    mutations: { retry: false },
  },
});

/** Public tenant info (name, timezone, SSO provider) resolved from the Host header. */
export function useTenant() {
  return useQuery({ queryKey: ['tenant'], queryFn: () => api.get<TenantInfo>('/tenant', { auth: false, quiet: true }), staleTime: Infinity });
}
