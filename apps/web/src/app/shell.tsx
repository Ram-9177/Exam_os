import { NavLink, Outlet, useNavigate } from 'react-router';
import type { RoleCode } from '@examos/contracts';
import { useAuth } from '@/lib/auth';
import { useTenant } from './queries';
import { Button, cn } from '@/ui';

interface NavItem {
  to: string;
  label: string;
  roles: RoleCode[];
}

const NAV: NavItem[] = [
  { to: '/student', label: 'My exams', roles: ['STUDENT'] },
  { to: '/student/ledger', label: 'Results', roles: ['STUDENT'] },
  { to: '/student/profile', label: 'Profile & ID', roles: ['STUDENT'] },
  { to: '/examcell', label: 'Exams', roles: ['EXAM_CELL_OPERATOR', 'CONTROLLER'] },
  { to: '/examcell/coding', label: 'Coding languages', roles: ['EXAM_CELL_OPERATOR', 'CONTROLLER'] },
  { to: '/evaluate', label: 'Marking', roles: ['EVALUATOR', 'MODERATOR'] },
  { to: '/proctor', label: 'Invigilation', roles: ['PROCTOR', 'CHIEF_PROCTOR'] },
  { to: '/analytics', label: 'Academic Analytics', roles: ['HOD', 'REPORT_VIEWER', 'EXAM_CELL_OPERATOR', 'CONTROLLER'] },
  { to: '/admin', label: 'Administration', roles: ['TENANT_ADMIN', 'SYSTEM_ADMIN', 'INTEGRATION_ADMIN', 'SECURITY_AUDITOR', 'CONTROLLER'] },
];

/** The quiet frame around every non-exam screen: tenant name, section links, who is signed in. */
export function AppShell() {
  const { me, user, hasRole, logout } = useAuth();
  const tenant = useTenant();
  const navigate = useNavigate();
  const items = NAV.filter((n) => hasRole(...n.roles));
  const tenantName = me?.tenant.name ?? tenant.data?.name ?? 'ExamOS';

  return (
    <div className="min-h-dvh flex flex-col">
      <a href="#main" className="visually-hidden focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-sheet focus:px-3 focus:py-2 focus:rounded-md">
        Skip to content
      </a>
      <header className="no-print border-b border-rule bg-paper">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex flex-wrap items-center gap-x-6 gap-y-2 min-h-14 py-2">
          <div className="flex items-baseline gap-3 mr-auto">
            <span className="font-serif text-xl text-ink" style={{ fontVariationSettings: "'opsz' 36" }}>
              {tenantName}
            </span>
            <span className="text-sm text-ink-2">Examinations</span>
          </div>
          <nav aria-label="Sections" className="flex gap-1 order-last w-full sm:order-none sm:w-auto overflow-x-auto">
            {items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/student' || n.to === '/examcell'} className={({ isActive }) => cn('px-3 py-1.5 rounded-md text-[15px] whitespace-nowrap', isActive ? 'bg-sheet-2 text-ink font-medium' : 'text-ink-2 hover:text-ink')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-2 truncate max-w-48">{user?.fullName ?? me?.email}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void logout().then(() => navigate('/login'));
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
