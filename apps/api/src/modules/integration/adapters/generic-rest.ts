import {
  type ErpSyncEntity,
  AcademicUnitSchema,
  CourseSchema,
  PersonSchema,
  EnrollmentSchema,
} from '@examos/contracts';
import type { ErpAdapter, ErpConnectionRow, ErpPullData } from './types.js';

export class GenericRestAdapter implements ErpAdapter {
  readonly provider = 'generic-rest';

  private mapFields(obj: Record<string, unknown>, fieldMap?: Record<string, string>): Record<string, unknown> {
    if (!fieldMap) return obj;
    const mapped: Record<string, unknown> = { ...obj };
    for (const [sourceKey, targetKey] of Object.entries(fieldMap)) {
      if (sourceKey in obj) {
        mapped[targetKey] = obj[sourceKey];
      }
    }
    return mapped;
  }

  async pull(
    connection: ErpConnectionRow,
    entity: ErpSyncEntity,
    secret?: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ErpPullData> {
    const baseUrl = (connection.base_url ?? '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Generic REST connection requires base_url');

    const mapping = (connection.mapping ?? {}) as Record<string, unknown>;
    const unitsPath = (mapping['unitsPath'] as string) || '/departments';
    const coursesPath = (mapping['coursesPath'] as string) || '/courses';
    const personsPath = (mapping['personsPath'] as string) || '/users';
    const enrollmentsPath = (mapping['enrollmentsPath'] as string) || '/enrollments';
    const fieldMap = mapping['fieldMap'] as Record<string, string> | undefined;

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(mapping['customHeaders'] as Record<string, string> | undefined),
    };
    if (secret) {
      const authHeaderName = (mapping['authHeaderName'] as string) || 'authorization';
      const authPrefix = (mapping['authPrefix'] as string) ?? 'Bearer ';
      headers[authHeaderName] = `${authPrefix}${secret}`;
    }

    const result: ErpPullData = {};

    if (entity === 'ALL' || entity === 'ACADEMIC_UNIT') {
      const res = await fetchImpl(`${baseUrl}${unitsPath}`, { headers });
      if (!res.ok) throw new Error(`Generic REST units error: HTTP ${res.status}`);
      const json = (await res.json()) as { items?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.items ?? json.data ?? []);
      result.academicUnits = items.map((x) =>
        AcademicUnitSchema.parse(this.mapFields(x as Record<string, unknown>, fieldMap)),
      );
    }

    if (entity === 'ALL' || entity === 'COURSE') {
      const res = await fetchImpl(`${baseUrl}${coursesPath}`, { headers });
      if (!res.ok) throw new Error(`Generic REST courses error: HTTP ${res.status}`);
      const json = (await res.json()) as { items?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.items ?? json.data ?? []);
      result.courses = items.map((x) =>
        CourseSchema.parse(this.mapFields(x as Record<string, unknown>, fieldMap)),
      );
    }

    if (entity === 'ALL' || entity === 'PERSON') {
      const res = await fetchImpl(`${baseUrl}${personsPath}`, { headers });
      if (!res.ok) throw new Error(`Generic REST persons error: HTTP ${res.status}`);
      const json = (await res.json()) as { items?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.items ?? json.data ?? []);
      result.persons = items.map((x) =>
        PersonSchema.parse(this.mapFields(x as Record<string, unknown>, fieldMap)),
      );
    }

    if (entity === 'ALL' || entity === 'ENROLLMENT') {
      const res = await fetchImpl(`${baseUrl}${enrollmentsPath}`, { headers });
      if (!res.ok) throw new Error(`Generic REST enrollments error: HTTP ${res.status}`);
      const json = (await res.json()) as { items?: unknown[]; data?: unknown[] } | unknown[];
      const items = Array.isArray(json) ? json : (json.items ?? json.data ?? []);
      result.enrollments = items.map((x) =>
        EnrollmentSchema.parse(this.mapFields(x as Record<string, unknown>, fieldMap)),
      );
    }

    return result;
  }
}

