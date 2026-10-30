import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router';
import type { IdCardVerificationData } from '@examos/contracts';
import { Badge, EmptyState, Skeleton, Stamp } from '@/ui';
import { fetchPublicStudentVerification } from './api';

export function StudentVerifyPage() {
  const { hash } = useParams<{ hash: string }>();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<IdCardVerificationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hash) {
      setError('No verification hash provided.');
      setLoading(false);
      return;
    }

    let isMounted = true;
    fetchPublicStudentVerification(hash)
      .then((res) => {
        if (isMounted) {
          setData(res.verification);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(
            err instanceof Error
              ? err.message
              : 'The verification credential could not be confirmed. It may be invalid or expired.'
          );
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [hash]);

  return (
    <div className="min-h-screen bg-paper py-12 px-4 sm:px-6 flex flex-col justify-center items-center">
      <div className="w-full max-w-lg bg-sheet border-2 border-rule rounded-xl shadow-lg p-6 sm:p-8 space-y-6">
        <div className="text-center border-b border-rule pb-5">
          <p className="text-xs uppercase tracking-widest text-ink-3 font-semibold">
            {data?.tenantName ?? "St. Mary's University"}
          </p>
          <h1 className="text-2xl font-serif font-bold text-ink mt-1">
            Student Identity Verification
          </h1>
          <p className="text-xs text-ink-2 mt-1">
            University Examination Section · Cryptographic Identity Ledger
          </p>
        </div>

        {loading ? (
          <div className="space-y-4 py-6">
            <Skeleton lines={4} />
          </div>
        ) : error || !data ? (
          <div className="text-center py-6 space-y-4">
            <div className="inline-flex p-3 rounded-full bg-stop-soft text-stop mb-2">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-ink">Verification Refused</h2>
            <p className="text-sm text-ink-2 max-w-sm mx-auto">{error}</p>
            <div className="pt-2">
              <Badge tone="stop">INVALID CREDENTIAL</Badge>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center justify-center gap-2">
              <Badge tone="ready">GENUINE CREDENTIAL</Badge>
              <span className="text-xs text-ink-3 font-mono">SHA-256 Validated</span>
            </div>

            <div className="sheet p-5 space-y-4 border border-rule rounded-lg">
              <div>
                <span className="text-xs text-ink-3 uppercase block font-medium">Student Full Name</span>
                <span className="text-lg font-bold text-ink block mt-0.5">{data.fullName}</span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-xs text-ink-3 uppercase block font-medium">Register Number</span>
                  <span className="text-base font-mono font-semibold text-ink block mt-0.5">
                    {data.registerNumber}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-ink-3 uppercase block font-medium">Current Semester</span>
                  <span className="text-base font-medium text-ink block mt-0.5">
                    {data.currentSemester ? `Semester ${data.currentSemester}` : '—'}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-xs text-ink-3 uppercase block font-medium">Department</span>
                <span className="text-sm font-medium text-ink block mt-0.5">
                  {data.departmentName ? `${data.departmentName} (${data.departmentCode})` : '—'}
                </span>
              </div>

              <div>
                <span className="text-xs text-ink-3 uppercase block font-medium">Programme</span>
                <span className="text-sm font-medium text-ink block mt-0.5">
                  {data.programmeName ? `${data.programmeName} (${data.programmeCode})` : '—'}
                </span>
              </div>
            </div>

            <div className="p-3 bg-sheet-2 border border-rule rounded text-xs text-ink-2 text-center">
              Verified by Examination Controller Authority. This student is currently active and eligible for university examinations.
            </div>
          </div>
        )}

        <div className="text-center pt-2 border-t border-rule">
          <Link to="/login" className="text-xs text-accent hover:underline font-medium">
            Return to Examination Portal
          </Link>
        </div>
      </div>
    </div>
  );
}

