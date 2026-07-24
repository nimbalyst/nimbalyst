import { Express } from 'express';
import { UserHandler } from './handlers';
import { requireRole } from '../auth/middleware';
import { validate } from '../utils/helpers';
import { CreateUserSchema, UpdateUserSchema } from '../models/user';

export function registerRoutes(app: Express): void {
  const users = new UserHandler();

  // User management
  app.get('/api/users', requireRole('admin'), users.list);
  app.get('/api/users/:id', users.getById);
  app.post('/api/users', requireRole('admin'), validate(CreateUserSchema), users.create);
  app.put('/api/users/:id', validate(UpdateUserSchema), users.update);
  app.delete('/api/users/:id', requireRole('admin'), users.delete);

  // Projects
  app.get('/api/projects', users.listProjects);
  app.post('/api/projects', users.createProject);
  app.get('/api/projects/:id', users.getProject);
  app.put('/api/projects/:id', users.updateProject);
  app.delete('/api/projects/:id', requireRole('admin'), users.deleteProject);

  // Health & status
  app.get('/api/status', (_req, res) => {
    res.json({
      version: process.env.npm_package_version,
      environment: process.env.NODE_ENV,
      uptime: Math.floor(process.uptime()),
    });
  });
}
