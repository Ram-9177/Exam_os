import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodingLanguagesPage } from '@/features/examcell/CodingLanguagesPage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const status = {
  judge: 'CONNECTED',
  error: null,
  projects: true,
  languages: [
    { id: 'c', label: 'C', version: 'GCC 9.2.0', group: 'Systems', judge0: 50, installed: true },
    { id: 'java', label: 'Java', version: 'OpenJDK 13.0.1', group: 'Application', judge0: 62, installed: true },
    { id: 'python', label: 'Python 3', version: '3.8.1', group: 'Scripting and web', judge0: 71, installed: true },
    { id: 'r', label: 'R', version: '4.0.0', group: 'Data and science', judge0: 80, installed: false },
  ],
};

describe('coding languages per subject', () => {
  it('shows each subject’s languages and the sandbox; the Examination Section changes a subject’s list', async () => {
    const me = signInAs(['EXAM_CELL_OPERATOR'], { id: 'u1', email: 'cell@demo.local', fullName: 'Exam Cell', kind: 'STAFF' });
    const puts: Array<{ path: string; body: unknown }> = [];
    let ds = { code: 'DS301', name: 'Data Science', departmentCode: 'CSE', profile: null as null | { languages: string[]; default: string } };
    mockFetch(({ method, path, body }) => {
      if (path === '/auth/me') return { json: me };
      if (path === '/tenant') return { json: TENANT };
      if (path === '/coding/languages') return { json: status };
      if (path === '/coding/subjects') return { json: { defaults: ['c', 'cpp', 'java', 'python'], subjects: [{ code: 'CS201', name: 'Data Structures', departmentCode: 'CSE', profile: { languages: ['c', 'cpp', 'java'], default: 'java' } }, ds] } };
      if (method === 'PUT' && path === '/coding/subjects/DS301') {
        puts.push({ path, body });
        ds = { ...ds, profile: (body as { profile: { languages: string[]; default: string } }).profile };
        return { json: { code: 'DS301', profile: ds.profile } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderApp([{ path: '/examcell/coding', element: <CodingLanguagesPage /> }], '/examcell/coding');
    expect(await screen.findByText('Sandbox connected')).toBeInTheDocument();
    expect(screen.getByText(/3 of 4 languages installed; multi-file projects available/)).toBeInTheDocument();
    const subjects = screen.getByRole('list', { name: 'Subjects' });
    expect(within(subjects).getByText('C, C++, Java · opens in Java')).toBeInTheDocument();
    expect(within(subjects).getByText('Any language (no list set)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change languages for DS301' }));
    // starts from the usual four; Data Science wants Python, R and SQL, opening in Python
    for (const l of ['C', 'C++', 'Java']) await user.click(screen.getByLabelText(l, { exact: true }));
    await user.click(screen.getByLabelText(/^R\s*\(not installed\)$/));
    await user.click(screen.getByLabelText('SQL'));
    expect(screen.getByText('(not installed)')).toBeInTheDocument(); // R is not in this sandbox yet
    expect(screen.getByLabelText('Opens in')).toHaveValue('python');
    await user.click(screen.getByRole('button', { name: 'Save 3 languages' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ profile: { languages: ['python', 'r', 'sql'], default: 'python' } });
    expect(await within(subjects).findByText('Python 3, R, SQL · opens in Python 3')).toBeInTheDocument();
  });

  it('says plainly when no sandbox is connected', async () => {
    const me = signInAs(['CONTROLLER']);
    mockFetch(({ path }) => (path === '/auth/me' ? { json: me } : path === '/tenant' ? { json: TENANT } : path === '/coding/languages' ? { json: { ...status, judge: 'NOT_CONFIGURED', projects: null, languages: status.languages.map((l) => ({ ...l, installed: null })) } } : path === '/coding/subjects' ? { json: { defaults: [], subjects: [] } } : undefined));
    renderApp([{ path: '/examcell/coding', element: <CodingLanguagesPage /> }], '/examcell/coding');
    expect(await screen.findByText('No sandbox')).toBeInTheDocument();
    expect(screen.getByText(/examiners mark it by reading/)).toBeInTheDocument();
    expect(await screen.findByText('No subjects')).toBeInTheDocument();
  });
});
