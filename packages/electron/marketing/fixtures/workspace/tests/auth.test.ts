import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { db } from '../src/models/database';

describe('Authentication', () => {
  let validToken: string;
  let apiKey: string;

  beforeAll(async () => {
    // Create test user and get credentials
    validToken = 'test-jwt-token';
    apiKey = 'ak_test_1234567890';
  });

  afterAll(async () => {
    await db.end();
  });

  describe('JWT Authentication', () => {
    it('accepts valid Bearer token', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(res.body.users).toBeDefined();
    });

    it('rejects expired token', async () => {
      await request(app)
        .get('/api/users')
        .set('Authorization', 'Bearer expired-token')
        .expect(401);
    });

    it('rejects missing token', async () => {
      await request(app).get('/api/users').expect(401);
    });
  });

  describe('API Key Authentication', () => {
    it('accepts valid API key', async () => {
      const res = await request(app)
        .get('/api/projects')
        .set('X-API-Key', apiKey)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it('rejects revoked API key', async () => {
      await request(app)
        .get('/api/projects')
        .set('X-API-Key', 'ak_revoked_key')
        .expect(401);
    });
  });
});
