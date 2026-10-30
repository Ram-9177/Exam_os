import {
  type ErpSyncEntity,
  AcademicUnitSchema,
  CourseSchema,
  PersonSchema,
  EnrollmentSchema,
} from '@examos/contracts';
import type { ErpAdapter, ErpConnectionRow, ErpPullData } from './types.js';

export class UosAdapter implements ErpAdapter {
  readonly provider = 'uos';

  async pull(
    connection: ErpConnectionRow,
    entity: ErpSyncEntity,
    secret?: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ErpPullData> {
    const baseUrl = (connection.base_url ?? '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('UOS connection requires base_url');

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-examos-tenant': connection.tenant_id,
    };
    if (secret) {
      headers['authorization'] = `Bearer ${secret}`;
    }

    const result: ErpPullData = {};

    if (entity === 'ALL' || entity === 'ACADEMIC_UNIT') {
      const res = await fetchImpl(`${baseUrl}/api/v1/academic-units`, { headers });
      if (!res.ok) throw new Error(`UOS academic-units error: HTTP ${res.status}`);
      const json = (await res.json()) as { academicUnits?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.academicUnits ?? json.data ?? []);
      result.academicUnits = items.map((x) => AcademicUnitSchema.parse(x));
    }

    if (entity === 'ALL' || entity === 'COURSE') {
      const res = await fetchImpl(`${baseUrl}/api/v1/courses`, { headers });
      if (!res.ok) throw new Error(`UOS courses error: HTTP ${res.status}`);
      const json = (await res.json()) as { courses?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.courses ?? json.data ?? []);
      result.courses = items.map((x) => CourseSchema.parse(x));
    }

    if (entity === 'ALL' || entity === 'PERSON') {
      const res = await fetchImpl(`${baseUrl}/api/v1/persons`, { headers });
      if (!res.ok) throw new Error(`UOS persons error: HTTP ${res.status}`);
      const json = (await res.json()) as { persons?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.persons ?? json.data ?? []);
      result.persons = items.map((x) => PersonSchema.parse(x));
    }

    if (entity === 'ALL' || entity === 'ENROLLMENT') {
      const res = await fetchImpl(`${baseUrl}/api/v1/enrollments`, { headers });
      if (!res.ok) throw new Error(`UOS enrollments error: HTTP ${res.status}`);
      const json = (await res.json()) as { enrollments?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.enrollments ?? json.data ?? []);
      result.enrollments = items.map((x) => EnrollmentSchema.parse(x));
    }

    return result;
  }
}

