import { useState, useRef, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/time';
import {
  Button,
  Dialog,
  Checkbox,
  EmptyState,
  PageTitle,
  Skeleton,
  StatusChip,
  Badge,
  useToast,
  cn,
} from '@/ui';
import {
  useStudentProfile,
  useStudentIdCard,
  uploadStudentPhoto,
} from './api';

export function ProfilePage() {
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const profileQuery = useStudentProfile();
  const idCardQuery = useStudentIdCard();

  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [photoKey, setPhotoKey] = useState(Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const profile = profileQuery.data?.profile;
  const idCard = idCardQuery.data?.idCard;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setFileError('Please select a JPG, PNG, or WebP image.');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setFileError('Image file size must be less than 2MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setPhotoDataUrl(reader.result as string);
    };
    reader.onerror = () => {
      setFileError('Failed to read the selected file.');
    };
    reader.readAsDataURL(file);
  };

  const handleUploadSubmit = async () => {
    if (!photoDataUrl) {
      setFileError('Please choose a photograph to upload.');
      return;
    }
    if (!consentGiven) {
      setFileError('Consent is required to upload an identity photograph.');
      return;
    }

    setIsSubmitting(true);
    try {
      await uploadStudentPhoto({
        photoDataUrl,
        consentGiven: true,
      });
      toast({
        title: 'Photograph uploaded successfully',
        description: 'Your official examination photograph has been recorded.',
        tone: 'success',
      });
      setIsUploadOpen(false);
      setPhotoDataUrl(null);
      setConsentGiven(false);
      setPhotoKey(Date.now());
      void queryClient.invalidateQueries({ queryKey: ['student', 'profile'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'id-card'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setFileError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (profileQuery.isLoading) {
    return (
      <div className="max-w-5xl space-y-6">
        <Skeleton lines={4} />
        <Skeleton lines={6} />
      </div>
    );
  }

  if (profileQuery.isError || !profile) {
    return (
      <div className="max-w-5xl">
        <EmptyState title="Could not load student profile">
          Your student identity records could not be retrieved. Please refresh or contact the Examination Section.
        </EmptyState>
      </div>
    );
  }

  const { student, department, programme, documents, hallTickets, cumulative } = profile;
  const photoSrc = documents.photo ? `/api/v1/student/profile/photo?t=${photoKey}` : null;

  return (
    <div className="max-w-5xl space-y-10">
      <div className="no-print">
        <PageTitle
          title="Student Profile & ID"
          lede="Official identity details, verifiable university examination credential, and academic progression record."
        />
      </div>

      {/* Main Identity & Profile Section */}
      <section aria-labelledby="profile-heading" className="no-print sheet p-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 pb-6 border-b border-rule">
          <div className="flex items-center gap-5">
            <div className="relative">
              {photoSrc ? (
                <img
                  src={photoSrc}
                  alt={`${student.fullName} profile photo`}
                  className="w-24 h-24 rounded-full object-cover border-2 border-rule bg-sheet-2 shadow-sm"
                />
              ) : (
                <div
                  data-testid="photo-placeholder"
                  className="w-24 h-24 rounded-full bg-sheet-2 border-2 border-dashed border-rule flex items-center justify-center text-ink-3 text-2xl font-serif"
                >
                  {student.fullName.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="profile-heading" className="text-xl font-serif text-ink font-semibold">
                  {student.fullName}
                </h2>
                <Badge tone="accent">{student.registerNumber ?? 'PENDING'}</Badge>
              </div>
              <p className="text-sm text-ink-2 mt-0.5">{student.email}</p>
              <p className="text-xs text-ink-3 mt-1">
                {documents.photo ? 'Official Photo Verified' : 'Photograph Required'}
              </p>
            </div>
          </div>

          <Button
            variant="secondary"
            onClick={() => {
              setPhotoDataUrl(null);
              setFileError(null);
              setConsentGiven(false);
              setIsUploadOpen(true);
            }}
          >
            {documents.photo ? 'Update Photograph' : 'Upload Photograph'}
          </Button>
        </div>

        {/* Academic Profile Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pt-6">
          <div>
            <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Department</span>
            <span className="text-sm font-medium text-ink mt-1 block">
              {department ? `${department.name} (${department.code})` : '—'}
            </span>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Programme</span>
            <span className="text-sm font-medium text-ink mt-1 block">
              {programme ? `${programme.name} (${programme.code})` : '—'}
            </span>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Register Number</span>
            <span className="text-sm font-mono text-ink mt-1 block">
              {student.registerNumber ?? 'Not assigned'}
            </span>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Admission Batch</span>
            <span className="text-sm text-ink mt-1 block">{student.admissionBatch ?? '—'}</span>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Current Semester / Section</span>
            <span className="text-sm text-ink mt-1 block">
              {student.currentSemester ? `Semester ${student.currentSemester}` : '—'}
              {student.section ? ` · Sec ${student.section}` : ''}
            </span>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase tracking-wider block font-medium">Language Preference</span>
            <span className="text-sm text-ink mt-1 block">{student.preferredLanguage ?? 'English'}</span>
          </div>
        </div>
      </section>

      {/* Verifiable Student ID Card Section */}
      <section aria-labelledby="id-card-heading" className="space-y-4">
        <div className="flex items-center justify-between no-print">
          <div>
            <h2 id="id-card-heading" className="text-lg font-serif text-ink font-semibold">
              Examination Identity Card
            </h2>
            <p className="text-sm text-ink-2">
              Tamper-evident card carrying your cryptographic verification QR code for in-person invigilation.
            </p>
          </div>
          <Button variant="secondary" onClick={() => window.print()} className="no-print">
            Print ID Card
          </Button>
        </div>

        {idCard ? (
          <div
            data-testid="id-card-container"
            className="w-full max-w-xl mx-auto rounded-xl border-2 border-rule bg-sheet p-6 shadow-md transition-shadow relative overflow-hidden"
          >
            {/* ID Card Header */}
            <div className="flex items-center justify-between border-b border-rule pb-4 mb-4">
              <div>
                <span className="text-xs uppercase tracking-widest text-ink-3 font-semibold block">
                  {idCard.tenantName}
                </span>
                <span className="text-base font-serif text-ink font-bold block">
                  EXAMINATION IDENTITY CARD
                </span>
              </div>
              <Badge tone="ready">VALID</Badge>
            </div>

            {/* ID Card Content */}
            <div className="flex flex-col sm:flex-row gap-5 items-center">
              <div className="shrink-0 text-center">
                {photoSrc ? (
                  <img
                    src={photoSrc}
                    alt={`${student.fullName} ID Photo`}
                    className="w-28 h-32 rounded-md object-cover border border-rule bg-sheet-2 shadow-inner"
                  />
                ) : (
                  <div className="w-28 h-32 rounded-md bg-sheet-2 border border-dashed border-rule flex items-center justify-center text-ink-3 text-3xl font-serif">
                    {student.fullName.charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="text-[11px] text-ink-3 mt-1.5 block font-mono">
                  Sem {student.currentSemester ?? '—'}
                </span>
              </div>

              <div className="flex-1 space-y-2 text-center sm:text-left">
                <div>
                  <h3 className="text-lg font-bold text-ink leading-snug">{student.fullName}</h3>
                  <p className="text-sm font-mono text-ink-2 font-semibold">
                    REG: {student.registerNumber ?? '—'}
                  </p>
                </div>

                <div className="text-xs text-ink-2 space-y-0.5">
                  <p>
                    <span className="font-medium text-ink">Dept:</span> {department?.name ?? '—'}
                  </p>
                  <p>
                    <span className="font-medium text-ink">Prog:</span> {programme?.name ?? '—'}
                  </p>
                  <p>
                    <span className="font-medium text-ink">Issued:</span> {formatDate(idCard.issuedAt, tz)}
                  </p>
                </div>
              </div>

              {/* QR Verification Code */}
              <div className="shrink-0 flex flex-col items-center">
                <img
                  src={idCard.qrDataUrl}
                  alt="Identity Verification QR Code"
                  className="w-24 h-24 border border-rule rounded bg-white p-1"
                />
                <span className="text-[10px] text-ink-3 mt-1 font-mono uppercase">
                  Scan to Verify
                </span>
              </div>
            </div>

            {/* ID Card Footer */}
            <div className="mt-4 pt-3 border-t border-rule flex items-center justify-between text-[11px] text-ink-3">
              <span>Authority: Examination Section</span>
              <span className="font-mono">Security Check: SHA-256</span>
            </div>
          </div>
        ) : (
          <div className="sheet p-6 text-center text-ink-2">
            Register number must be assigned to generate your verifiable ID card.
          </div>
        )}
      </section>

      {/* Academic Performance & Progression Analytics */}
      <section aria-labelledby="analytics-heading" className="no-print space-y-6">
        <div>
          <h2 id="analytics-heading" className="text-lg font-serif text-ink font-semibold">
            Academic Analytics & Performance Progression
          </h2>
          <p className="text-sm text-ink-2">
            Cumulative performance metrics computed exclusively from Controller-published exam records.
          </p>
        </div>

        {/* KPI Tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule border border-rule rounded-md overflow-hidden">
          <div className="bg-sheet p-4 text-center">
            <span className="text-xs text-ink-3 uppercase block font-medium">Completed Exams</span>
            <span className="text-2xl font-serif text-ink mt-1 block font-semibold">
              {cumulative.totalExams}
            </span>
          </div>
          <div className="bg-sheet p-4 text-center">
            <span className="text-xs text-ink-3 uppercase block font-medium">Total Marks</span>
            <span className="text-2xl font-mono text-ink mt-1 block">
              {cumulative.totalMarks} / {cumulative.totalMax}
            </span>
          </div>
          <div className="bg-sheet p-4 text-center">
            <span className="text-xs text-ink-3 uppercase block font-medium">Average Percentage</span>
            <span className="text-2xl font-mono text-ink mt-1 block">
              {cumulative.percentage.toFixed(1)}%
            </span>
          </div>
          <div className="bg-sheet p-4 text-center">
            <span className="text-xs text-ink-3 uppercase block font-medium">Cumulative GPA</span>
            <span className="text-2xl font-mono text-accent mt-1 block font-bold">
              {cumulative.gpa.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Academic Progression SVG Chart */}
        {cumulative.totalExams > 0 ? (
          <div className="sheet p-6 space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-2">
              Performance Trend Across Published Exams
            </h3>
            <div className="w-full overflow-x-auto py-2">
              <svg
                viewBox="0 0 600 200"
                className="w-full h-48 select-none"
                aria-label="Student exam marks progression chart"
                role="img"
              >
                {/* Background grid lines */}
                <line x1="40" y1="20" x2="580" y2="20" stroke="var(--rule)" strokeDasharray="3 3" />
                <line x1="40" y1="60" x2="580" y2="60" stroke="var(--rule)" strokeDasharray="3 3" />
                <line x1="40" y1="100" x2="580" y2="100" stroke="var(--rule)" strokeDasharray="3 3" />
                <line x1="40" y1="140" x2="580" y2="140" stroke="var(--rule)" strokeDasharray="3 3" />
                <line x1="40" y1="180" x2="580" y2="180" stroke="var(--rule)" />

                {/* Y Axis labels */}
                <text x="32" y="24" textAnchor="end" className="text-[10px] fill-ink-3 font-mono">100%</text>
                <text x="32" y="64" textAnchor="end" className="text-[10px] fill-ink-3 font-mono">75%</text>
                <text x="32" y="104" textAnchor="end" className="text-[10px] fill-ink-3 font-mono">50%</text>
                <text x="32" y="144" textAnchor="end" className="text-[10px] fill-ink-3 font-mono">25%</text>
                <text x="32" y="184" textAnchor="end" className="text-[10px] fill-ink-3 font-mono">0%</text>

                {/* Horizontal reference bar for percentage */}
                <rect
                  x="80"
                  y={180 - (cumulative.percentage / 100) * 160}
                  width="120"
                  height={(cumulative.percentage / 100) * 160}
                  rx="4"
                  fill="var(--accent)"
                  opacity="0.85"
                />
                <text
                  x="140"
                  y={Math.max(35, 170 - (cumulative.percentage / 100) * 160)}
                  textAnchor="middle"
                  className="text-[12px] font-mono font-bold fill-ink"
                >
                  {cumulative.percentage.toFixed(1)}%
                </text>
                <text
                  x="140"
                  y="196"
                  textAnchor="middle"
                  className="text-[11px] font-medium fill-ink-2"
                >
                  Overall Average
                </text>

                {/* Pass threshold indicator at 40% */}
                <line x1="40" y1="116" x2="580" y2="116" stroke="var(--fix)" strokeDasharray="4 2" />
                <text x="575" y="112" textAnchor="end" className="text-[9px] fill-fix font-mono">
                  Pass Mark (40%)
                </text>
              </svg>
            </div>
          </div>
        ) : (
          <div className="sheet p-6 text-center text-ink-2">
            No published results available to graph. Analytics update automatically as results are published.
          </div>
        )}
      </section>

      {/* Hall Tickets Section */}
      <section aria-labelledby="hall-tickets-heading" className="no-print space-y-4">
        <h2 id="hall-tickets-heading" className="text-lg font-serif text-ink font-semibold">
          Active Examination Hall Tickets
        </h2>
        {hallTickets.length === 0 ? (
          <div className="sheet p-6 text-center text-ink-2">
            No active hall tickets issued. Registered exam hall tickets will appear here before exam start.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {hallTickets.map((ht) => (
              <div key={ht.examId} className="sheet p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-ink">{ht.examTitle}</h3>
                    <p className="text-xs text-ink-2 font-mono">{ht.examCode}</p>
                  </div>
                  <Badge tone="note">{ht.examType}</Badge>
                </div>
                <div className="text-xs space-y-1 text-ink-2">
                  <p>
                    <span className="font-medium text-ink">Hall Ticket:</span>{' '}
                    <span className="font-mono">{ht.hallTicketNumber}</span>
                  </p>
                  <p>
                    <span className="font-medium text-ink">Window:</span>{' '}
                    {formatDate(ht.windowStartAt, tz)} - {formatDate(ht.windowEndAt, tz)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Upload Photograph Modal Dialog */}
      <Dialog
        open={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        title="Upload Examination Photograph"
        description="Provide a recent passport-style photograph with a clear front-facing view for identity verification."
      >
        <div className="space-y-5 py-2">
          {fileError ? (
            <div className="p-3 rounded-md bg-stop-soft text-stop text-sm" role="alert">
              {fileError}
            </div>
          ) : null}

          <div>
            <label htmlFor="photo-file" className="block text-sm font-medium text-ink mb-1">
              Select Image File (Max 2MB)
            </label>
            <input
              ref={fileInputRef}
              id="photo-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              className="block w-full text-sm text-ink-2 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-sheet-2 file:text-ink hover:file:bg-sheet cursor-pointer"
            />
          </div>

          {photoDataUrl ? (
            <div className="text-center p-3 border border-rule rounded-md bg-sheet-2">
              <span className="text-xs text-ink-3 uppercase block mb-2">Preview</span>
              <img
                src={photoDataUrl}
                alt="Selected photograph preview"
                className="w-32 h-36 mx-auto rounded object-cover border border-rule shadow"
              />
            </div>
          ) : null}

          <div className="pt-2">
            <Checkbox
              checked={consentGiven}
              onChange={(e) => setConsentGiven(e.target.checked)}
              label="I give explicit consent for St. Mary's University Examination Section to store and process this photograph for examination identification, hall ticket generation, and proctoring verification."
            />
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-rule">
            <Button variant="ghost" onClick={() => setIsUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!photoDataUrl || !consentGiven || isSubmitting}
              onClick={handleUploadSubmit}
            >
              {isSubmitting ? 'Uploading...' : 'Confirm & Save Photo'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
