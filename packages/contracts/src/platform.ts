import { z } from 'zod';
import { TENANT_STATUSES, USER_STATUSES } from './enums.js';

export const PlatformLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(256),
  otp: z.string().regex(/^\d{6}$/),
});
export const TenantSettingsSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  staffLoginLimit: z.union([z.literal(3), z.literal(4)]).optional(),
  domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/)).min(1).max(10).optional(),
});
export const UserStatusSchema = z.object({ status: z.enum(USER_STATUSES) });
