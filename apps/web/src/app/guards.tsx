import { Navigate, Outlet, useLocation } from 'react-router';
import type { RoleCode } from '@examos/contracts';
import { homeFor, useAuth } from '@/lib/auth';
import { EmptyState, Skeleton } from '@/ui';

export function RequireAuth() {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl p-10">
        <Skeleton lines={4} />
      </div>
    );
  }
  if (status === 'anonymous') return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

export function RequireRole({ roles }: { roles: RoleCode[] }) {
  const { hasRole, me, status } = useAuth();
  if (status === 'loading' || !me) return <Skeleton lines={3} className="p-10" />;
  if (!hasRole(...roles)) {
    return (
      <div className="mx-auto max-w-xl py-16">
        <EmptyState title="This section is not part of your role">
          Your account is signed in, but it has no access here. If you believe it should, ask the Examination Section to update your role.
        </EmptyState>
      </div>
    );
  }
  return <Outlet />;
}

/** `/` sends each person to their own home. */
export function RootRedirect() {
  const { status, roles } = useAuth();
  if (status === 'loading') return <Skeleton lines={3} className="p-10" />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <Navigate to={homeFor(roles)} replace />;
}
