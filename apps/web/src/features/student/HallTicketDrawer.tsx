import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { Button, Dialog, KeyValue, PrintIcon, Stamp } from '@/ui';
import { EXAM_TYPE_LABEL, type StudentExam, useStudentSignature } from './api';

/** The hall ticket: the one document a student may be asked to show at the door. Printable. */
export function HallTicketDrawer({ exam, open, onClose, timeZone, tenantName }: { exam: StudentExam; open: boolean; onClose: () => void; timeZone: string; tenantName: string }) {
  const { user, me } = useAuth();
  const sigQuery = useStudentSignature();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      variant="drawer"
      title="Hall ticket"
      description="Keep this number handy; the invigilator may ask for it."
      footer={
        <div className="flex gap-2">
          {exam.hallTicketNumber ? (
            <Button
              variant="primary"
              onClick={() => void api.download(`/student/me/exams/${exam.examId}/hall-ticket.pdf`, `hall-ticket-${exam.code}.pdf`)}
            >
              Download PDF
            </Button>
          ) : null}
          <Button variant="secondary" leading={<PrintIcon />} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      }
    >
      <article className="hall-ticket border border-ink rounded-md p-6 bg-sheet" aria-label="Hall ticket">
        <header className="flex items-start justify-between gap-4 border-b border-rule pb-4">
          <div>
            <p className="font-serif text-xl" style={{ fontVariationSettings: "'opsz' 36" }}>
              {tenantName}
            </p>
            <p className="text-sm text-ink-2">Examination hall ticket</p>
          </div>
          <Stamp tone={exam.hallTicketNumber ? 'ready' : 'note'} className="text-base">
            {exam.hallTicketNumber ? 'Issued' : 'Pending'}
          </Stamp>
        </header>
        <div className="py-5">
          <p className="text-sm text-ink-2">Hall ticket number</p>
          <p className="font-mono text-3xl tabular tracking-wide mt-1">{exam.hallTicketNumber ?? 'Not issued yet'}</p>
        </div>
        <KeyValue
          items={[
            { k: 'Name', v: user?.fullName ?? me?.email ?? '—' },
            { k: 'E-mail', v: me?.email ?? user?.email ?? '—' },
            { k: 'Exam', v: `${exam.title} (${exam.code})` },
            { k: 'Type', v: EXAM_TYPE_LABEL[exam.examType] },
            { k: 'Course', v: exam.courseName ? `${exam.courseCode ?? ''} ${exam.courseName}`.trim() : (exam.courseCode ?? '—') },
            { k: 'Window', v: `${formatDateTime(exam.windowStartAt, timeZone)} to ${formatDateTime(exam.windowEndAt, timeZone)}` },
            { k: 'Duration', v: `${exam.durationMinutes} minutes${exam.extraTimeMinutes ? ` + ${exam.extraTimeMinutes} approved extra` : ''}` },
          ]}
        />
        {exam.hallTicketVerification ? (
          <div className="mt-6 pt-4 border-t border-rule">
            <p className="text-sm text-ink-2">Verification</p>
            <p className="font-mono text-xs break-all mt-1">{exam.hallTicketVerification}</p>
          </div>
        ) : null}

        {/* Dynamic Dual Signatures */}
        <div className="mt-8 pt-6 border-t border-rule grid grid-cols-2 gap-4 text-center items-end">
          <div className="flex flex-col items-center">
            {sigQuery.data?.signatureDataUrl ? (
              <img
                src={sigQuery.data.signatureDataUrl}
                alt="Signature of Candidate"
                className="max-h-12 max-w-full object-contain mb-1"
              />
            ) : (
              <div className="h-12 flex items-center justify-center text-xs text-ink-3 italic">
                (No signature on file)
              </div>
            )}
            <div className="border-t border-ink w-36 pt-1 text-xs font-semibold text-ink">
              Candidate's Signature
            </div>
            <p className="text-[11px] text-ink-2 truncate max-w-44 mt-0.5">({user?.fullName ?? me?.email ?? 'Candidate'})</p>
          </div>
          <div className="flex flex-col items-center">
            <div className="h-12 flex items-center justify-center">
              <span className="font-serif italic text-ink font-semibold text-sm tracking-wide">
                Controller of Examinations
              </span>
            </div>
            <div className="border-t border-ink w-36 pt-1 text-xs font-semibold text-ink">
              Controller of Examinations
            </div>
            <p className="text-[11px] text-ink-2 mt-0.5">(St. Mary's University)</p>
          </div>
        </div>
      </article>
    </Dialog>
  );
}
