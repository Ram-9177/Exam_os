import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { useTenant } from '@/app/queries';
import { Button, EmptyState, PrintIcon, Skeleton, Stamp } from '@/ui';
import { BookletView, type Booklet } from './BookletView';

export function useBooklet(attemptId: string) {
  return useQuery({ queryKey: ['booklet', attemptId], queryFn: () => api.get<Booklet>(`/student/attempts/${attemptId}/booklet`, { quiet: ['NOT_PUBLISHED', 'PACKET_NOT_FOUND'] }), enabled: !!attemptId, retry: false });
}

export function BookletPage() {
  const { attemptId = '' } = useParams();
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const booklet = useBooklet(attemptId);

  if (booklet.isLoading) return <Skeleton lines={8} className="max-w-3xl" />;
  if (booklet.isError) {
    if (isApiError(booklet.error, 'NOT_PUBLISHED')) return <EmptyState title="Not published yet">The booklet opens once the Examination Cell has approved your result and the Controller has published it.</EmptyState>;
    return <EmptyState title="This booklet is not available">Check the link, or go back to your exams.</EmptyState>;
  }
  if (!booklet.data) return null;

  return (
    <div>
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-4 max-w-[210mm] mx-auto">
        <p className="text-ink-2">Your answers, the marks awarded and the examiner's explanation for each question, as published.</p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => void api.download(`/student/attempts/${attemptId}/booklet.pdf`, `booklet-${attemptId}.pdf`)}
          >
            Download PDF
          </Button>
          <Button variant="secondary" leading={<PrintIcon />} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <BookletView booklet={booklet.data} tz={tz} />
    </div>
  );
}

interface VerifyResponse {
  valid: boolean;
  published?: boolean;
  version?: number;
  publishedAt?: string | null;
  total?: number;
  max?: number;
}

/** Public: anyone with the URL printed on a booklet can confirm the result is the published version. */
export function VerifyPage() {
  const { attemptId = '', version = '' } = useParams();
  const tenant = useTenant();
  const tz = tenant.data?.timezone ?? 'Asia/Kolkata';
  const q = useQuery({ queryKey: ['verify', attemptId, version], queryFn: () => api.get<VerifyResponse>(`/student/verify/${attemptId}/${version}`, { auth: false, quiet: true }), enabled: !!attemptId && !!version, retry: false });

  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="w-full max-w-md">
        <p className="font-serif text-2xl" style={{ fontVariationSettings: "'opsz' 36" }}>
          {tenant.data?.name ?? 'ExamOS'}
        </p>
        <p className="text-ink-2 mb-6">Result verification</p>
        <section className="sheet p-6" aria-live="polite">
          {q.isLoading ? <Skeleton lines={3} /> : null}
          {q.isError ? <p className="text-ink-2">The verification service could not be reached. Try again in a moment.</p> : null}
          {q.data ? (
            <>
              <Stamp tone={q.data.valid ? 'ready' : 'stop'} className="text-2xl">
                {q.data.valid ? 'Verified' : 'Not verified'}
              </Stamp>
              <p className="mt-5">
                {q.data.valid ? 'This is the published version of the result for this attempt.' : q.data.published ? 'A result is published for this attempt, but not this version. The printed booklet may be superseded.' : 'No published result matches this reference.'}
              </p>
              {q.data.valid ? (
                <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
                  <dt className="text-ink-2">Version</dt>
                  <dd className="font-mono">{q.data.version}</dd>
                  <dt className="text-ink-2">Total</dt>
                  <dd className="font-mono tabular">
                    {q.data.total} / {q.data.max}
                  </dd>
                  <dt className="text-ink-2">Published</dt>
                  <dd>{formatDateTime(q.data.publishedAt, tz)}</dd>
                </dl>
              ) : null}
              <p className="mt-4 text-xs text-ink-3 font-mono break-all">
                {attemptId} · v{version}
              </p>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
