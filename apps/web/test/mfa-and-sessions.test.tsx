import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@/features/auth/LoginPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { SecurityAndSessions } from '@/features/student/SecurityAndSessions';
import { getTokens, setTokens } from '@/lib/api';
import { mockFetch, problem, renderApp, signInAs, TENANT } from './helpers';

describe('Module 1: MFA, Branding, Sessions and Audit', () => {
  it('LoginPage renders 2FA prompt on MFA_REQUIRED and sends mfaCode', async () => {
    setTokens(null);
    let loginCalls = 0;
    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'POST' && path === '/auth/login') {
        loginCalls++;
        const b = body as { email: string; password: string; mfaCode?: string };
        if (!b.mfaCode) {
          return problem(401, 'MFA_REQUIRED', 'Two-factor authentication code required');
        }
        if (b.mfaCode === '123456') {
          return {
            json: {
              accessToken: 'mfa-access-token',
              refreshToken: 'r'.repeat(30),
              expiresIn: 600,
              user: { id: 'u1', email: b.email, fullName: 'Staff User', kind: 'STAFF' },
            },
          };
        }
        return problem(401, 'MFA_CODE_INVALID', 'Invalid authentication code');
      }
      if (method === 'GET' && path === '/auth/me') {
        return {
          json: {
            userId: 'u1',
            email: 'admin@demo.local',
            kind: 'STAFF',
            grants: [{ role: 'TENANT_ADMIN', scopeType: 'TENANT', scopeId: null }],
            tenant: TENANT,
          },
        };
      }
      return undefined;
    });

    renderApp(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/admin', element: <h1>Admin Page</h1> },
      ],
      '/login'
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail'), 'admin@demo.local');
    await user.type(screen.getByLabelText('Password'), 'SecretPassword123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Expect 2FA challenge field to appear
    expect(await screen.findByLabelText('Authenticator Code / Recovery Code')).toBeInTheDocument();

    // Type 6-digit TOTP code and sign in
    await user.type(screen.getByLabelText('Authenticator Code / Recovery Code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify & Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Admin Page' })).toBeInTheDocument();
    expect(getTokens()?.accessToken).toBe('mfa-access-token');
  });

  it('AdminPage renders Campus Branding tab, preview, and saves branding updates', async () => {
    signInAs(['TENANT_ADMIN']);
    let updatedBranding: unknown = null;
    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === '/auth/me') {
        return {
          json: {
            userId: 'u1',
            email: 'admin@demo.local',
            kind: 'STAFF',
            grants: [{ role: 'TENANT_ADMIN', scopeType: 'TENANT', scopeId: null }],
            tenant: TENANT,
          },
        };
      }
      if (method === 'GET' && path === '/tenant/users?q=&kind=') return { json: { users: [] } };
      if (method === 'GET' && path === '/tenant/branding') {
        return {
          json: {
            branding: {
              logoUrl: 'https://demo.local/logo.png',
              primaryColor: '#1e3fb8',
              accentColor: '#9db0ff',
              headerText: "St. Mary's University — Main Campus",
              contactEmail: 'examcell@stmarys.edu',
            },
          },
        };
      }
      if (method === 'PUT' && path === '/tenant/branding') {
        updatedBranding = body;
        return { json: { branding: body } };
      }
      return undefined;
    });

    renderApp([{ path: '/admin', element: <AdminPage /> }], '/admin');

    const user = userEvent.setup();
    const brandingTab = await screen.findByRole('tab', { name: 'Campus branding' });
    await user.click(brandingTab);

    expect(await screen.findByText('Campus Branding & Documents')).toBeInTheDocument();
    expect(screen.getByText('Live Document Header Preview')).toBeInTheDocument();

    const headerInput = screen.getByLabelText('Official Campus Header / Name');
    expect(headerInput).toHaveValue("St. Mary's University — Main Campus");

    await user.clear(headerInput);
    await user.type(headerInput, "St. Mary's University — Engineering Campus");

    const saveButton = screen.getByRole('button', { name: 'Save branding' });
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    await waitFor(() => {
      expect(updatedBranding).toMatchObject({
        headerText: "St. Mary's University — Engineering Campus",
      });
    });
  });

  it('AdminPage renders Active Sessions tab, allows session revocation and emergency force logout', async () => {
    signInAs(['TENANT_ADMIN']);
    let revokedSessionId: string | null = null;
    let emergencyRevoked = false;

    mockFetch(({ method, path }) => {
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === '/auth/me') {
        return {
          json: {
            userId: 'u1',
            email: 'admin@demo.local',
            kind: 'STAFF',
            grants: [{ role: 'TENANT_ADMIN', scopeType: 'TENANT', scopeId: null }],
            tenant: TENANT,
          },
        };
      }
      if (method === 'GET' && path === '/tenant/users?q=&kind=') return { json: { users: [] } };
      if (method === 'GET' && path === '/tenant/sessions') {
        return {
          json: {
            sessions: [
              {
                id: 'sess-1',
                user_id: 'u1',
                email: 'controller@demo.local',
                full_name: 'Controller Office',
                role_codes: ['CONTROLLER'],
                client_ip: '192.168.1.100',
                user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
                issued_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (method === 'DELETE' && path === '/tenant/sessions/sess-1') {
        revokedSessionId = 'sess-1';
        return { json: { revoked: true } };
      }
      if (method === 'POST' && path === '/tenant/revoke-all-sessions') {
        emergencyRevoked = true;
        return { json: { message: 'All sessions revoked', revokedAt: new Date().toISOString() } };
      }
      return undefined;
    });

    renderApp([{ path: '/admin', element: <AdminPage /> }], '/admin');

    const user = userEvent.setup();
    const sessionsTab = await screen.findByRole('tab', { name: 'Active sessions' });
    await user.click(sessionsTab);

    expect(await screen.findByText('Active Campus Sessions (1)')).toBeInTheDocument();
    expect(screen.getByText('Controller Office')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.100')).toBeInTheDocument();

    // Revoke individual session
    const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
    await user.click(revokeBtn);
    await waitFor(() => expect(revokedSessionId).toBe('sess-1'));

    // Emergency revoke dialog
    const forceLogoutBtn = screen.getByRole('button', { name: 'Force Logout All Campus Sessions' });
    await user.click(forceLogoutBtn);

    expect(await screen.findByRole('heading', { name: 'Force Logout All Campus Sessions?' })).toBeInTheDocument();
    const confirmBtn = screen.getByRole('button', { name: 'Confirm Emergency Logout' });
    await user.click(confirmBtn);

    await waitFor(() => expect(emergencyRevoked).toBe(true));
  });

  it('SecurityAndSessions component displays TOTP setup and recovery codes', async () => {
    signInAs(['CONTROLLER']);
    let activatedCode: string | null = null;

    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') {
        return {
          json: {
            userId: 'u1',
            email: 'controller@demo.local',
            kind: 'STAFF',
            grants: [{ role: 'CONTROLLER', scopeType: 'TENANT', scopeId: null }],
            tenant: TENANT,
          },
        };
      }
      if (method === 'GET' && path === '/auth/mfa/status') {
        return { json: { enabled: false, required: true, privileged: true } };
      }
      if (method === 'GET' && path === '/auth/sessions') {
        return {
          json: {
            sessions: [
              {
                id: 'sess-curr',
                client_ip: '10.0.0.1',
                user_agent: 'Chrome/120',
                issued_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (method === 'POST' && path === '/auth/mfa/setup') {
        return {
          json: {
            secret: 'JBSWY3DPEHPK3PXP',
            uri: 'otpauth://totp/ExamOS:person@demo.local?secret=JBSWY3DPEHPK3PXP&issuer=ExamOS',
            recoveryCodes: ['11112222', '33334444', '55556666'],
          },
        };
      }
      if (method === 'POST' && path === '/auth/mfa/activate') {
        activatedCode = (body as { code: string }).code;
        return { json: { enabled: true } };
      }
      return undefined;
    });

    renderApp([{ path: '/sec', element: <SecurityAndSessions tz="Asia/Kolkata" /> }], '/sec');

    const user = userEvent.setup();
    expect(await screen.findByText('Two-Factor Authentication (TOTP)')).toBeInTheDocument();
    expect(screen.getByText('Mandatory')).toBeInTheDocument();

    const setupBtn = screen.getByRole('button', { name: 'Set up Authenticator (2FA)' });
    await user.click(setupBtn);

    expect(await screen.findByText('Step 1: Add to Authenticator App')).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText('11112222')).toBeInTheDocument();

    const codeInput = screen.getByLabelText('Verification Code');
    await user.type(codeInput, '654321');

    const activateBtn = screen.getByRole('button', { name: 'Verify & Activate 2FA' });
    await user.click(activateBtn);

    await waitFor(() => expect(activatedCode).toBe('654321'));
  });
});
