import { z } from 'zod';

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  visibility: z.enum(['public', 'private']).default('private'),
});

export interface Project {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  visibility: 'public' | 'private';
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectStats extends Project {
  memberCount: number;
  taskCount: number;
  completedTaskCount: number;
}
