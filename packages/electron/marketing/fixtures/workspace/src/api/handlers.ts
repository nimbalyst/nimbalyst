import { Request, Response } from 'express';
import { db } from '../models/database';
import { createLogger } from '../utils/logger';
import { NotFoundError, ForbiddenError } from '../utils/helpers';

const logger = createLogger('handlers');

export class UserHandler {
  async list(req: Request, res: Response): Promise<void> {
    const { page = 1, limit = 20, role } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = 'SELECT * FROM users';
    const params: any[] = [];

    if (role) {
      query += ' WHERE role = $1';
      params.push(role);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), offset);

    const result = await db.query(query, params);
    const total = await db.query('SELECT COUNT(*) FROM users');

    res.json({
      users: result.rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: Number(total.rows[0].count),
      },
    });
  }

  async getById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);

    if (!result.rows[0]) {
      throw new NotFoundError(`User ${id} not found`);
    }

    res.json(result.rows[0]);
  }

  async create(req: Request, res: Response): Promise<void> {
    const { email, name, role } = req.body;

    const result = await db.query(
      'INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING *',
      [email, name, role || 'user']
    );

    logger.info(`User created: ${email}`);
    res.status(201).json(result.rows[0]);
  }

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const user = (req as any).user;

    // Users can only update their own profile (admins can update anyone)
    if (user.role !== 'admin' && user.id !== id) {
      throw new ForbiddenError('Cannot update other users');
    }

    const { name, email } = req.body;
    const result = await db.query(
      'UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, email, id]
    );

    if (!result.rows[0]) {
      throw new NotFoundError(`User ${id} not found`);
    }

    res.json(result.rows[0]);
  }

  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    logger.info(`User deleted: ${id}`);
    res.status(204).send();
  }

  // Project methods
  async listProjects(req: Request, res: Response): Promise<void> {
    const user = (req as any).user;
    const result = await db.query(
      'SELECT * FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC',
      [user.id]
    );
    res.json(result.rows);
  }

  async createProject(req: Request, res: Response): Promise<void> {
    const user = (req as any).user;
    const { name, description } = req.body;

    const result = await db.query(
      'INSERT INTO projects (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [name, description, user.id]
    );

    res.status(201).json(result.rows[0]);
  }

  async getProject(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM projects WHERE id = $1', [id]);

    if (!result.rows[0]) {
      throw new NotFoundError(`Project ${id} not found`);
    }

    res.json(result.rows[0]);
  }

  async updateProject(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { name, description } = req.body;

    const result = await db.query(
      'UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, description, id]
    );

    res.json(result.rows[0]);
  }

  async deleteProject(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    await db.query('DELETE FROM projects WHERE id = $1', [id]);
    res.status(204).send();
  }
}

export function handleWebSocketConnection(ws: any, clientId: string): void {
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      logger.debug(`WS message from ${clientId}:`, message);

      switch (message.type) {
        case 'subscribe':
          // Subscribe to project updates
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        default:
          logger.warn(`Unknown WS message type: ${message.type}`);
      }
    } catch (err) {
      logger.error('Failed to parse WS message', err);
    }
  });
}
