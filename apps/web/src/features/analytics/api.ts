import { useQuery } from '@tanstack/react-query';
import type { DepartmentAnalyticsData } from '@examos/contracts';
import { api } from '@/lib/api';

export interface OverviewDepartmentSummary {
  id: string;
  code: string;
  name: string;
  studentCount: number;
  publishedRecordsCount: number;
  passRate: number;
  avgPercentage: number;
}

export interface OverviewAnalyticsData {
  departments: OverviewDepartmentSummary[];
}

export function useDepartmentAnalytics(departmentId: string | null) {
  return useQuery({
    queryKey: ['analytics', 'department', departmentId],
    queryFn: () => api.get<{ analytics: DepartmentAnalyticsData }>(`/analytics/department/${departmentId}`),
    enabled: !!departmentId,
  });
}

export function useOverviewAnalytics() {
  return useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: () => api.get<{ overview: OverviewAnalyticsData }>('/analytics/overview'),
  });
}

