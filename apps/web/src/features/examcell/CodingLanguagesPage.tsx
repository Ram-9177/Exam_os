import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CODE_LANGUAGE_CATALOGUE, codeLanguage } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { Badge, Button, EmptyState, Field, PageTitle, Select, Skeleton, TextInput, useToast } from '@/ui';

interface Subject {
  code: string;
  name: string;
  departmentCode: string | null;
  profile: { languages: string[]; default?: string } | null;
}
interface LanguageStatus {
  judge: 'CONNECTED' | 'UNREACHABLE' | 'NOT_CONFIGURED';
  error: string | null;
  projects: boolean | null;
  languages: Array<{ id: string; label: string; version: string; group: string; judge0: number; installed: boolean | null }>;
}

const GROUPS = [...new Set(CODE_LANGUAGE_CATALOGUE.map((l) => l.group))];

/**
 * Coding languages per subject. The Examination Section decides which languages each subject's coding questions may
 * use (CS201 Data Structures: C, C++, Java; DS301 Data Science: Python, R, SQL …). Question setters then pick from
 * that list only, and students see only what their question allows. The sandbox status shows what IT has installed.
 */
export function CodingLanguagesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const subjects = useQuery({ queryKey: ['coding', 'subjects'], queryFn: () => api.get<{ subjects: Subject[]; defaults: string[] }>('/coding/subjects') });
  const status = useQuery({ queryKey: ['coding', 'languages'], queryFn: () => api.get<LanguageStatus>('/coding/languages'), staleTime: 60_000 });
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ languages: string[]; default: string }>({ languages: [], default: '' });
  const [saving, setSaving] = useState(false);

  const installed = useMemo(() => new Map((status.data?.languages ?? []).map((l) => [l.id, l.installed])), [status.data]);
  const list = (subjects.data?.subjects ?? []).filter((s) => !filter.trim() || `${s.code} ${s.name} ${s.departmentCode ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));

  const edit = (s: Subject) => {
    const langs = s.profile?.languages ?? [...(subjects.data?.defaults ?? ['c', 'cpp', 'java', 'python'])];
    setDraft({ languages: langs, default: s.profile?.default ?? langs[0] ?? '' });
    setEditing(s.code);
  };
  const save = async (code: string, profile: { languages: string[]; default: string } | null) => {
    setSaving(true);
    try {
      await api.put(`/coding/subjects/${encodeURIComponent(code)}`, { profile });
      toast({ tone: 'success', title: profile ? `${code}: ${profile.languages.length} languages` : `${code}: any language` });
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['coding', 'subjects'] });
    } catch (e) {
      toast({ tone: 'warning', title: 'Not saved', description: isApiError(e) ? (e.problem.detail ?? e.problem.title) : 'Network or server error' });
    } finally {
      setSaving(false);
    }
  };
  const toggle = (id: string, on: boolean) =>
    setDraft((d) => {
      const languages = on ? CODE_LANGUAGE_CATALOGUE.map((l) => l.id).filter((x) => x === id || d.languages.includes(x)) : d.languages.filter((x) => x !== id);
      return { languages, default: languages.includes(d.default) ? d.default : (languages[0] ?? '') };
    });

  return (
    <div>
      <PageTitle kicker="Examination Section" title="Coding languages" lede="Choose which programming languages each subject uses. Coding questions in that subject can offer only these, and students see only what their question allows." />

      <section aria-label="Code sandbox" className="mb-6 rounded-md border border-rule p-4 text-sm">
        {status.isLoading ? (
          <Skeleton lines={1} />
        ) : status.data?.judge === 'CONNECTED' ? (
          <p>
            <Badge tone="ready">Sandbox connected</Badge> {status.data.languages.filter((l) => l.installed).length} of {status.data.languages.length} languages installed{status.data.projects === false ? '; multi-file projects are not available' : status.data.projects ? '; multi-file projects available' : ''}.
          </p>
        ) : status.data?.judge === 'UNREACHABLE' ? (
          <p>
            <Badge tone="stop">Sandbox not answering</Badge> {status.data.error}. Programs are queued and graded when it is back; examiners can mark without it.
          </p>
        ) : (
          <p>
            <Badge tone="neutral">No sandbox</Badge> IT has not connected Judge0 (JUDGE_URL), so programs are not run. Students can still write code and examiners mark it by reading.
          </p>
        )}
      </section>

      <Field label="Find a subject" className="max-w-sm mb-4">
        {({ id }) => <TextInput id={id} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Code, name or department" />}
      </Field>

      {subjects.isLoading ? (
        <Skeleton lines={6} />
      ) : !list.length ? (
        <EmptyState title="No subjects">Subjects arrive from the ERP roster sync.</EmptyState>
      ) : (
        <ul className="divide-y divide-rule border border-rule rounded-md" aria-label="Subjects">
          {list.map((s) => (
            <li key={s.code} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="font-medium">
                    <span className="font-mono">{s.code}</span> {s.name}
                  </p>
                  <p className="text-sm text-ink-2">
                    {s.profile ? s.profile.languages.map((l) => codeLanguage(l)?.label ?? l).join(', ') : 'Any language (no list set)'}
                    {s.profile?.default ? ` · opens in ${codeLanguage(s.profile.default)?.label ?? s.profile.default}` : ''}
                  </p>
                </div>
                {editing !== s.code ? (
                  <Button size="sm" variant="secondary" onClick={() => edit(s)} aria-label={`Change languages for ${s.code}`}>
                    Change
                  </Button>
                ) : null}
              </div>
              {editing === s.code ? (
                <div className="mt-3 space-y-3">
                  {GROUPS.map((g) => (
                    <fieldset key={g}>
                      <legend className="text-xs text-ink-2 mb-1">{g}</legend>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {CODE_LANGUAGE_CATALOGUE.filter((l) => l.group === g).map((l) => (
                          <label key={l.id} className="flex items-center gap-1 text-sm" title={l.version}>
                            <input type="checkbox" checked={draft.languages.includes(l.id)} onChange={(e) => toggle(l.id, e.target.checked)} />
                            {l.label}
                            {installed.get(l.id) === false ? <span className="text-xs text-fix">(not installed)</span> : null}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                  <Field label="Opens in" className="w-60">
                    {({ id }) => (
                      <Select id={id} value={draft.default} onChange={(e) => setDraft((d) => ({ ...d, default: e.target.value }))} disabled={!draft.languages.length}>
                        {draft.languages.map((l) => (
                          <option key={l} value={l}>
                            {codeLanguage(l)?.label ?? l}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void save(s.code, draft)} loading={saving} disabled={!draft.languages.length}>
                      Save {draft.languages.length} languages
                    </Button>
                    {s.profile ? (
                      <Button size="sm" variant="ghost" onClick={() => void save(s.code, null)} disabled={saving}>
                        Allow any language
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
