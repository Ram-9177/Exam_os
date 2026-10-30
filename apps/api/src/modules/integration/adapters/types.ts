import type { Person, AcademicUnit, Course, Enrollment, ErpSyncEntity } from '@examos/contracts';

export interface ErpConnectionRow {
  id: string;
  tenant_id: string;
  provider: string;
  label: string;
  base_url: string | null;
  credential_ref: string | null;
  webhook_secret_ref: string | null;
  sync_schedule_cron: string | null;
  mapping: Record<string, unknown>;
  status: 'ACTIVE' | 'DISABLED';
  last_sync_at: Date | null;
}

export interface ErpPullData {
  academicUnits?: AcademicUnit[];
  courses?: Course[];
  persons?: Person[];
  enrollments?: Enrollment[];
}

export interface ErpAdapter {
  readonly provider: string;
  pull(
    connection: ErpConnectionRow,
    entity: ErpSyncEntity,
    secret?: string,
    fetchImpl?: typeof fetch,
  ): Promise<ErpPullData>;
}

