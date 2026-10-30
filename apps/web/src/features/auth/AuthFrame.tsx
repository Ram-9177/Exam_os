import type { ReactNode } from 'react';
import { useTenant } from '@/app/queries';

/** The sign-in frame: the university's name set like the head of a notice, one sheet beneath it. */
export function AuthFrame({ title, lede, children }: { title: ReactNode; lede?: ReactNode; children: ReactNode }) {
  const tenant = useTenant();
  return (
    <main className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <header className="mb-8">
          <p className="font-serif text-2xl text-ink" style={{ fontVariationSettings: "'opsz' 36" }}>
            {tenant.data?.name ?? (tenant.isLoading ? ' ' : 'ExamOS')}
          </p>
          <p className="text-ink-2">Examinations</p>
        </header>
        <section className="sheet p-6 sm:p-8">
          <h1 className="text-h2">{title}</h1>
          {lede ? <p className="mt-2 text-ink-2">{lede}</p> : null}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}
