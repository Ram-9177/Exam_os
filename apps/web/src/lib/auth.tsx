import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RoleCode, ScopeType } from '@examos/contracts';
import { api, apiEvents, getTokens, setDeviceSession, setTokens, type SessionUser, type TokenPair } from './api';

export interface Grant {
  role: RoleCode;
  scopeType: ScopeType;
  scopeId: string | null;
}
export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  ssoProvider?: string | null;
}
export interface Me {
  userId: string;
  email: string;
  kind: 'STUDENT' | 'STAFF' | string;
  grants: Grant[];
  tenant: TenantInfo;
}

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  user: SessionUser | null;
  roles: ReadonlySet<RoleCode>;
  hasRole: (...roles: RoleCode[]) => boolean;
  login: (email: string, password: string) => Promise<Me>;
  adoptTokens: (pair: TokenPair) => Promise<Me>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<Me | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => (getTokens() ? 'loading' : 'anonymous'));
  const [me, setMe] = useState<Me | null>(null);
  const [user, setUser] = useState<SessionUser | null>(() => getTokens()?.user ?? null);

  const refreshMe = useCallback(async (): Promise<Me | null> => {
    if (!getTokens()) {
      setStatus('anonymous');
      setMe(null);
      return null;
    }
    try {
      const m = await api.get<Me>('/auth/me', { quiet: true });
      setMe(m);
      setStatus('authenticated');
      return m;
    } catch {
      setMe(null);
      setStatus('anonymous');
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  useEffect(
    () =>
      apiEvents.on('signed-out', () => {
        setMe(null);
        setUser(null);
        setStatus('anonymous');
      }),
    [],
  );

  const adoptTokens = useCallback(
    async (pair: TokenPair): Promise<Me> => {
      setTokens(pair);
      setUser(pair.user);
      const m = await api.get<Me>('/auth/me');
      setMe(m);
      setStatus('authenticated');
      return m;
    },
    [],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<Me> => {
      const pair = await api.post<TokenPair>('/auth/login', { email, password }, { auth: false, quiet: ['INVALID_CREDENTIALS', 'RATE_LIMITED', 'VALIDATION'] });
      return adoptTokens(pair);
    },
    [adoptTokens],
  );

  const logout = useCallback(async () => {
    try {
      if (getTokens()) await api.post('/auth/logout', {}, { quiet: true });
    } catch {
      /* already signed out */
    }
    setTokens(null);
    setDeviceSession(null);
    setMe(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const roles = useMemo(() => new Set<RoleCode>((me?.grants ?? []).map((g) => g.role)), [me]);
  const hasRole = useCallback((...r: RoleCode[]) => r.some((x) => roles.has(x)), [roles]);

  const value = useMemo<AuthContextValue>(() => ({ status, me, user, roles, hasRole, login, adoptTokens, logout, refreshMe }), [status, me, user, roles, hasRole, login, adoptTokens, logout, refreshMe]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Where a signed-in person lands, by their strongest role. */
export function homeFor(roles: ReadonlySet<RoleCode>): string {
  if (roles.has('EXAM_CELL_OPERATOR') || roles.has('CONTROLLER')) return '/examcell';
  if (roles.has('CHIEF_PROCTOR') || roles.has('PROCTOR')) return '/proctor';
  if (roles.has('EVALUATOR') || roles.has('MODERATOR')) return '/evaluate';
  if (roles.has('HOD') || roles.has('REPORT_VIEWER')) return '/analytics';
  if (roles.has('TENANT_ADMIN') || roles.has('SYSTEM_ADMIN') || roles.has('INTEGRATION_ADMIN')) return '/admin';
  if (roles.has('STUDENT')) return '/student';
  if (roles.has('SECURITY_AUDITOR')) return '/admin';
  return '/student';
}
