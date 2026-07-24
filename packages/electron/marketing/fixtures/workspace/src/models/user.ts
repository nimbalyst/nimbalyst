import { z } from 'zod';

export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'user', 'viewer']).default('user'),
});

export const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(100).optional(),
}).refine((data) => data.email || data.name, {
  message: 'At least one field must be provided',
});

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user' | 'viewer';
  createdAt: Date;
  updatedAt: Date;
}

export interface UserWithApiKeys extends User {
  apiKeys: Array<{
    id: string;
    name: string;
    lastUsedAt: Date | null;
    createdAt: Date;
  }>;
}
