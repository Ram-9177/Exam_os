import { useState, useRef, useEffect, type ChangeEvent } from 'react';
import type { StudentProfileData, IdCardVerificationData } from '@examos/contracts';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/time';
import { api } from '@/lib/api';
import {
  Button,
  Dialog,
  Checkbox,
  EmptyState,
  PageTitle,
  Skeleton,
  Badge,
  Select,
  useToast,
} from '@/ui';
import {
  useStudentProfile,
  useStudentIdCard,
  useStudentSignature,
  useStudentPhoto,
  uploadStudentPhoto,
  uploadStudentSignature,
  deleteStudentSignature,
} from './api';

export function ProfilePage() {
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isStaff = me?.kind === 'STAFF';

  // For staff viewing students: load student roster
  const studentsQuery = useQuery({
    queryKey: ['tenant', 'students-roster-profile'],
    queryFn: () =>
      api.get<{ users: Array<{ id: string; fullName: string; email: string; registerNumber?: string | null }> }>(
        '/tenant/users?kind=STUDENT'
      ),
    enabled: isStaff,
  });
  const studentsList = studentsQuery.data?.users ?? [];
  const [selectedStudentId, setSelectedStudentId] = useState<string>('');
  const activeStudentId = isStaff ? (selectedStudentId || (studentsList[0]?.id ?? '')) : '';

  const profileQuery = useStudentProfile(activeStudentId || undefined);
  const idCardQuery = useStudentIdCard(activeStudentId || undefined);
  const signatureQuery = useStudentSignature(activeStudentId || undefined);

  // Photo modal state
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [photoKey, setPhotoKey] = useState(Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // E-Signature modal state
  const [isSigOpen, setIsSigOpen] = useState(false);
  const [sigMode, setSigMode] = useState<'upload' | 'draw'>('upload');
  const [sigDataUrl, setSigDataUrl] = useState<string | null>(null);
  const [sigError, setSigError] = useState<string | null>(null);
  const [sigBusy, setSigBusy] = useState(false);
  const sigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawingSig, setIsDrawingSig] = useState(false);

  const profile: StudentProfileData | undefined =
    (profileQuery.data as any)?.profile ?? (profileQuery.data as unknown as StudentProfileData);
  const idCard: (IdCardVerificationData & { qrDataUrl: string }) | undefined =
    (idCardQuery.data as any)?.idCard ?? (idCardQuery.data as unknown as (IdCardVerificationData & { qrDataUrl: string }));
  const signature = signatureQuery.data?.signatureDataUrl;

  const hasPhotoDoc = !!profile?.documents?.photo;
  const photoBlobQuery = useStudentPhoto(activeStudentId || undefined, hasPhotoDoc);
  const [uploadedPhotoPreview, setUploadedPhotoPreview] = useState<string | null>(null);
  const [photoLoadError, setPhotoLoadError] = useState(false);

  useEffect(() => {
    setUploadedPhotoPreview(null);
    setPhotoLoadError(false);
  }, [activeStudentId]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setFileError('Please select a JPG, PNG, or WebP image.');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setFileError('Image file size must be less than 5MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const raw = reader.result;
      const img = new Image();
      img.onload = () => {
        const maxDim = 400;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          setPhotoDataUrl(canvas.toDataURL('image/jpeg', 0.9));
        } else {
          setPhotoDataUrl(raw);
        }
      };
      img.onerror = () => {
        setPhotoDataUrl(raw);
      };
      img.src = raw;
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
      await uploadStudentPhoto(
        { photoDataUrl, consentGiven: true },
        activeStudentId || undefined
      );
      setUploadedPhotoPreview(photoDataUrl);
      setPhotoLoadError(false);
      toast({
        title: 'Photograph uploaded successfully',
        description: 'Official examination photograph has been recorded.',
        tone: 'success',
      });
      setIsUploadOpen(false);
      setPhotoDataUrl(null);
      setConsentGiven(false);
      setPhotoKey(Date.now());
      void queryClient.invalidateQueries({ queryKey: ['student', 'profile'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'id-card'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'photo'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setFileError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Signature handlers
  const handleSigFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    setSigError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setSigError('Signature image must be under 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const raw = reader.result;
      const img = new Image();
      img.onload = () => {
        const maxW = 500;
        const maxH = 150;
        let w = img.width;
        let h = img.height;
        if (w > maxW || h > maxH) {
          const ratio = Math.min(maxW / w, maxH / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          setSigDataUrl(canvas.toDataURL('image/png'));
        } else {
          setSigDataUrl(raw);
        }
      };
      img.onerror = () => {
        setSigDataUrl(raw);
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  };

  const startDrawingSig = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width || 1);
    const scaleY = canvas.height / (rect.height || 1);
    const touch = 'touches' in e ? e.touches[0] : null;
    const clientX = touch ? touch.clientX : ('clientX' in e ? e.clientX : 0);
    const clientY = touch ? touch.clientY : ('clientY' in e ? e.clientY : 0);
    ctx.beginPath();
    ctx.moveTo((clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    setIsDrawingSig(true);
  };

  const drawSig = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawingSig) return;
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / (rect.width || 1);
    const scaleY = canvas.height / (rect.height || 1);
    const touch = 'touches' in e ? e.touches[0] : null;
    const clientX = touch ? touch.clientX : ('clientX' in e ? e.clientX : 0);
    const clientY = touch ? touch.clientY : ('clientY' in e ? e.clientY : 0);
    ctx.lineTo((clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY);
    ctx.stroke();
  };

  const stopDrawingSig = () => {
    if (!isDrawingSig) return;
    setIsDrawingSig(false);
    const canvas = sigCanvasRef.current;
    if (canvas) {
      setSigDataUrl(canvas.toDataURL('image/png'));
    }
  };

  const clearSigCanvas = () => {
    const canvas = sigCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setSigDataUrl(null);
  };

  const saveSignature = async () => {
    if (!sigDataUrl) {
      setSigError('Please draw or choose a signature image first.');
      return;
    }
    setSigBusy(true);
    setSigError(null);
    try {
      await uploadStudentSignature({ signatureDataUrl: sigDataUrl }, activeStudentId || undefined);
      toast({
        tone: 'success',
        title: 'E-Signature recorded',
        description: 'Candidate signature updated and dynamically mapped to examination documents.',
      });
      setIsSigOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['student', 'signature'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'profile'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'id-card'] });
    } catch (err) {
      setSigError(err instanceof Error ? err.message : 'Could not save signature.');
    } finally {
      setSigBusy(false);
    }
  };

  const removeSignature = async () => {
    setSigBusy(true);
    setSigError(null);
    try {
      await deleteStudentSignature(activeStudentId || undefined);
      toast({
        tone: 'success',
        title: 'Signature removed',
        description: 'Candidate signature has been unmapped.',
      });
      setIsSigOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['student', 'signature'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'profile'] });
      void queryClient.invalidateQueries({ queryKey: ['student', 'id-card'] });
    } catch (err) {
      setSigError(err instanceof Error ? err.message : 'Could not remove signature.');
    } finally {
      setSigBusy(false);
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
      <div className="max-w-5xl space-y-4">
        {isStaff && studentsList.length > 0 ? (
          <div className="sheet p-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="text-xs uppercase tracking-wider font-semibold text-ink-3">Staff Mode</span>
              <p className="text-sm text-ink font-medium">Select a student record to inspect</p>
            </div>
            <div className="min-w-64">
              <Select
                value={activeStudentId}
                onChange={(e) => setSelectedStudentId(e.target.value)}
              >
                {studentsList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.registerNumber ?? s.email})
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ) : null}
        <EmptyState title="Could not load student profile">
          Your student identity records could not be retrieved. Please refresh or contact the Examination Section.
        </EmptyState>
      </div>
    );
  }

  const { student, department, programme, documents, hallTickets, cumulative } = profile;
  const photoSrc = uploadedPhotoPreview || photoBlobQuery.data || null;

  return (
    <div className="max-w-5xl space-y-10">
      <div className="no-print space-y-4">
        <PageTitle
          title="Student Profile & ID"
          lede="Official identity details, verifiable university examination credential, and academic progression record."
        />

        {isStaff && studentsList.length > 0 ? (
          <div className="sheet p-4 flex flex-wrap items-center justify-between gap-4 border-l-4 border-l-accent">
            <div>
              <span className="text-xs uppercase tracking-wider font-semibold text-accent">Staff Identity View</span>
              <p className="text-sm text-ink font-medium">Inspecting candidate credential for examination authorization</p>
            </div>
            <div className="min-w-72">
              <Select
                value={activeStudentId}
                onChange={(e) => setSelectedStudentId(e.target.value)}
              >
                {studentsList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.registerNumber ?? s.email})
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ) : null}
      </div>

      {/* Main Identity & Profile Section */}
      <section aria-labelledby="profile-heading" className="no-print sheet p-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 pb-6 border-b border-rule">
          <div className="flex items-center gap-5">
            <div className="relative">
              {photoSrc && !photoLoadError ? (
                <img
                  src={photoSrc}
                  alt={`${student.fullName} profile photo`}
                  className="w-24 h-24 rounded-full object-cover border-2 border-rule bg-sheet-2 shadow-sm"
                  onError={() => setPhotoLoadError(true)}
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
                {documents.photo || uploadedPhotoPreview ? 'Official Photo Verified' : 'Photograph Required'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setPhotoDataUrl(null);
                setFileError(null);
                setConsentGiven(false);
                setIsUploadOpen(true);
              }}
            >
              {documents.photo || uploadedPhotoPreview ? 'Update Photograph' : 'Upload Photograph'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setSigDataUrl(signature ?? null);
                setSigError(null);
                setIsSigOpen(true);
              }}
            >
              {signature ? 'Update E-Signature' : 'Upload E-Signature'}
            </Button>
          </div>
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

      {/* Official Candidate E-Signature Card */}
      <section aria-labelledby="signature-heading" className="no-print sheet p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-rule">
          <div>
            <h2 id="signature-heading" className="text-lg font-serif text-ink font-semibold">
              Official Candidate E-Signature
            </h2>
            <p className="text-sm text-ink-2">
              Cryptographically bound digital signature dynamically printed onto your examination hall tickets.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setSigDataUrl(signature ?? null);
              setSigError(null);
              setIsSigOpen(true);
            }}
          >
            {signature ? 'Manage Signature' : 'Add E-Signature'}
          </Button>
        </div>

        <div className="pt-4 flex flex-col sm:flex-row items-center gap-6">
          <div className="bg-white p-3 rounded-md border border-rule flex flex-col items-center justify-center min-w-56 min-h-24">
            {signature ? (
              <img src={signature} alt="Candidate digital signature" className="max-h-16 max-w-full object-contain mb-1" />
            ) : (
              <span className="text-xs text-ink-3 italic">No signature on file</span>
            )}
            <div className="border-t border-ink w-44 text-center text-xs font-semibold text-ink pt-1">
              Candidate's Signature
            </div>
          </div>
          <div className="text-xs text-ink-2 space-y-1">
            <p className="font-medium text-ink">
              Status: {signature ? <span className="text-ready font-semibold">Active &amp; Mapped</span> : <span className="text-fix font-semibold">Pending Signature</span>}
            </p>
            <p>
              Your digital e-signature appears on the bottom-left of every official examination hall ticket alongside the Controller of Examinations seal.
            </p>
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
                {photoSrc && !photoLoadError ? (
                  <img
                    src={photoSrc}
                    alt={`${student.fullName} ID Photo`}
                    className="w-28 h-32 rounded-md object-cover border border-rule bg-sheet-2 shadow-inner"
                    onError={() => setPhotoLoadError(true)}
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
            Academic Analytics &amp; Performance Progression
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
            <span className="text-2xl font-mono text-ink mt-1 block">
              {(cumulative as any).gpa !== undefined && (cumulative as any).gpa !== null
                ? Number((cumulative as any).gpa).toFixed(2)
                : (cumulative.percentage / 10).toFixed(2)}
            </span>
          </div>
        </div>

        {/* Visual Progression Graphic */}
        {cumulative.totalExams > 0 ? (
          <div className="sheet p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Overall Examination Standing Progression</h3>
              <span className="text-xs font-mono text-ink-3">Passing Criterion: 40%</span>
            </div>

            <div className="w-full overflow-x-auto">
              <svg viewBox="0 0 600 200" className="w-full h-48 select-none" role="img" aria-label="Student exam marks progression chart">
                {/* Horizontal reference lines */}
                <line x1="40" y1="20" x2="580" y2="20" stroke="var(--rule)" strokeDasharray="2 2" />
                <line x1="40" y1="60" x2="580" y2="60" stroke="var(--rule)" strokeDasharray="2 2" />
                <line x1="40" y1="100" x2="580" y2="100" stroke="var(--rule)" strokeDasharray="2 2" />
                <line x1="40" y1="140" x2="580" y2="140" stroke="var(--rule)" strokeDasharray="2 2" />
                <line x1="40" y1="180" x2="580" y2="180" stroke="var(--rule)" />

                {/* Y-axis labels */}
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
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void api.download(`/student/me/exams/${ht.examId}/hall-ticket.pdf`, `hall-ticket-${ht.examCode}.pdf`)}
                  >
                    Download Official PDF
                  </Button>
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
              Select Image File (Max 5MB)
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

      {/* Upload / Draw E-Signature Modal Dialog */}
      {isSigOpen ? (
        <Dialog
          open
          onClose={() => setIsSigOpen(false)}
          title={`Digital E-Signature — ${student.fullName}`}
          description="Upload or draw an official digital signature for this candidate. This signature automatically renders on examination hall tickets and authentic dossiers."
          size="md"
          footer={
            <div className="flex w-full items-center justify-between">
              <div>
                {signature ? (
                  <Button variant="danger" size="sm" onClick={() => void removeSignature()} loading={sigBusy}>
                    Remove signature
                  </Button>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setIsSigOpen(false)} disabled={sigBusy}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void saveSignature()} loading={sigBusy}>
                  Save E-Signature
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="flex border-b border-rule pb-2 gap-4">
              <button
                type="button"
                className={`text-sm font-medium pb-1 cursor-pointer transition-colors ${
                  sigMode === 'upload' ? 'border-b-2 border-accent text-accent font-semibold' : 'text-ink-2 hover:text-ink'
                }`}
                onClick={() => setSigMode('upload')}
              >
                Upload image
              </button>
              <button
                type="button"
                className={`text-sm font-medium pb-1 cursor-pointer transition-colors ${
                  sigMode === 'draw' ? 'border-b-2 border-accent text-accent font-semibold' : 'text-ink-2 hover:text-ink'
                }`}
                onClick={() => setSigMode('draw')}
              >
                Draw signature
              </button>
            </div>

            {sigMode === 'upload' ? (
              <div>
                <label htmlFor="sig-file-input" className="block text-sm font-medium text-ink mb-1">
                  Select signature image (PNG, JPEG, WebP)
                </label>
                <input
                  id="sig-file-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleSigFileUpload}
                  className="block w-full text-sm text-ink-2 file:mr-4 file:py-2 file:px-4 file:rounded file:border file:border-rule file:text-sm file:font-semibold file:bg-sheet-2 hover:file:bg-sheet cursor-pointer"
                />
                <p className="text-xs text-ink-3 mt-1.5">
                  Clear, dark ink on transparent or light background recommended.
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-ink">Draw signature inside the frame</span>
                  <Button size="sm" variant="ghost" onClick={clearSigCanvas}>
                    Clear
                  </Button>
                </div>
                <div className="border-2 border-dashed border-rule rounded bg-white overflow-hidden touch-none">
                  <canvas
                    ref={sigCanvasRef}
                    width={400}
                    height={120}
                    className="w-full h-30 cursor-crosshair block"
                    onMouseDown={startDrawingSig}
                    onMouseMove={drawSig}
                    onMouseUp={stopDrawingSig}
                    onMouseLeave={stopDrawingSig}
                    onTouchStart={startDrawingSig}
                    onTouchMove={drawSig}
                    onTouchEnd={stopDrawingSig}
                  />
                </div>
                <p className="text-xs text-ink-3 mt-1.5">
                  Use your mouse, trackpad, or pen/finger to sign.
                </p>
              </div>
            )}

            {sigDataUrl ? (
              <div className="p-3 border border-rule rounded bg-sheet-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-3 mb-2">Signature Preview</p>
                <div className="bg-white p-3 rounded border border-rule flex flex-col items-center justify-center min-h-24">
                  <img src={sigDataUrl} alt="Signature preview" className="max-h-16 max-w-full object-contain mb-1" />
                  <div className="border-t border-ink w-48 text-center text-xs font-semibold text-ink pt-1">
                    Candidate's Signature
                  </div>
                </div>
              </div>
            ) : null}

            {sigError ? (
              <p className="text-stop text-sm" role="alert">
                {sigError}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
