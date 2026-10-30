import { createBrowserRouter, Outlet } from 'react-router';
import { AppShell } from './shell';
import { RequireAuth, RequireRole, RootRedirect } from './guards';
import { ActivatePage, LoginPage, OidcCallbackPage } from '@/features/auth/LoginPage';
import { MyExamsPage } from '@/features/student/MyExamsPage';
import { LedgerPage } from '@/features/student/LedgerPage';
import { ProfilePage } from '@/features/student/ProfilePage';
import { StudentVerifyPage } from '@/features/student/StudentVerifyPage';
import { ReadinessPage } from '@/features/readiness/ReadinessPage';
import { ExamWorkspace } from '@/features/exam/ExamWorkspace';
import { BookletPage, VerifyPage } from '@/features/booklet/BookletPage';
import { EmptyState, Skeleton } from '@/ui';

function NotFound() {
  return (
    <div className="mx-auto max-w-xl py-16">
      <EmptyState title="There is nothing at this address">Check the link, or use the sections at the top of the page.</EmptyState>
    </div>
  );
}

/** Staff screens load on demand; the student path (login, exams, readiness, exam, booklet) is in the main bundle. */
export const router = createBrowserRouter([
  { path: '/', element: <RootRedirect /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/activate', element: <ActivatePage /> },
  { path: '/auth/callback', element: <OidcCallbackPage /> },
  { path: '/verify/:attemptId/:version', element: <VerifyPage /> },
  { path: '/student/verify-student/:hash', element: <StudentVerifyPage /> },
  {
    element: <RequireAuth />,
    children: [
      // The exam workspace has no shell: nothing on screen but the paper, the clock and the questions.
      {
        element: <RequireRole roles={['STUDENT']} />,
        children: [{ path: '/student/attempts/:attemptId/exam', element: <ExamWorkspace /> }],
      },
      {
        element: <AppShell />,
        children: [
          {
            element: <RequireRole roles={['STUDENT']} />,
            children: [
              { path: '/student', element: <MyExamsPage /> },
              { path: '/student/ledger', element: <LedgerPage /> },
              { path: '/student/profile', element: <ProfilePage /> },
              { path: '/student/attempts/:attemptId/readiness', element: <ReadinessPage /> },
            ],
          },
          {
            element: <RequireRole roles={['STUDENT', 'EVALUATOR', 'MODERATOR', 'EXAM_CELL_OPERATOR', 'CONTROLLER', 'HOD']} />,
            children: [{ path: '/student/attempts/:attemptId/booklet', element: <BookletPage /> }],
          },
          {
            element: <RequireRole roles={['EXAM_CELL_OPERATOR', 'CONTROLLER']} />,
            children: [
              { path: '/examcell', lazy: () => import('@/features/examcell/ExamListPage').then((m) => ({ Component: m.ExamListPage })) },
              { path: '/examcell/exams/new', lazy: () => import('@/features/examcell/ExamNewPage').then((m) => ({ Component: m.ExamNewPage })) },
              { path: '/examcell/exams/:id', lazy: () => import('@/features/examcell/ExamDetailPage').then((m) => ({ Component: m.ExamDetailPage })) },
            ],
          },
          {
            element: <RequireRole roles={['EVALUATOR', 'MODERATOR', 'EXAM_CELL_OPERATOR', 'CONTROLLER']} />,
            children: [
              { path: '/evaluate', lazy: () => import('@/features/evaluate/EvaluatePage').then((m) => ({ Component: m.EvaluateHomePage })) },
              { path: '/evaluate/:attemptId', lazy: () => import('@/features/evaluate/EvaluatePage').then((m) => ({ Component: m.EvaluatePage })) },
            ],
          },
          {
            element: <RequireRole roles={['PROCTOR', 'CHIEF_PROCTOR']} />,
            children: [{ path: '/proctor', lazy: () => import('@/features/proctor/ProctorPage').then((m) => ({ Component: m.ProctorPage })) }],
          },
          {
            element: <RequireRole roles={['HOD', 'REPORT_VIEWER', 'EXAM_CELL_OPERATOR', 'CONTROLLER', 'SYSTEM_ADMIN']} />,
            children: [{ path: '/analytics', lazy: () => import('@/features/analytics/AnalyticsPage').then((m) => ({ Component: m.AnalyticsPage })) }],
          },
          {
            element: <RequireRole roles={['TENANT_ADMIN', 'SYSTEM_ADMIN', 'INTEGRATION_ADMIN', 'SECURITY_AUDITOR', 'CONTROLLER']} />,
            children: [{ path: '/admin', lazy: () => import('@/features/admin/AdminPage').then((m) => ({ Component: m.AdminPage })) }],
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
  { path: '*', element: <Outlet /> },
], { hydrationData: undefined, hydrateFallbackElement: <Skeleton lines={3} className="p-10" /> } as Parameters<typeof createBrowserRouter>[1]);
