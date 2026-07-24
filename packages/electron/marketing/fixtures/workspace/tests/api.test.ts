import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';

describe('API Endpoints', () => {
  const authHeaders = { Authorization: 'Bearer test-token' };

  describe('GET /health', () => {
    it('returns status ok without auth', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.uptime).toBeDefined();
    });
  });

  describe('Users', () => {
    it('lists users with pagination', async () => {
      const res = await request(app)
        .get('/api/users?page=1&limit=10')
        .set(authHeaders)
        .expect(200);

      expect(res.body.pagination).toMatchObject({
        page: 1,
        limit: 10,
      });
    });

    it('creates a new user', async () => {
      const res = await request(app)
        .post('/api/users')
        .set(authHeaders)
        .send({ email: 'new@example.com', name: 'New User' })
        .expect(201);

      expect(res.body.email).toBe('new@example.com');
    });
  });

  describe('Projects', () => {
    it('creates and retrieves a project', async () => {
      const created = await request(app)
        .post('/api/projects')
        .set(authHeaders)
        .send({ name: 'Test Project', description: 'A test project' })
        .expect(201);

      const fetched = await request(app)
        .get(`/api/projects/${created.body.id}`)
        .set(authHeaders)
        .expect(200);

      expect(fetched.body.name).toBe('Test Project');
    });
  });
});
