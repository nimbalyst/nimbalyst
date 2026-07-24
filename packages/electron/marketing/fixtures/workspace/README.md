# Acme API Server

A high-performance REST API server built with TypeScript and Express, powering the Acme platform's backend services.

## Features

- JWT and API key authentication
- Role-based access control (RBAC)
- Rate limiting with Redis backing store
- WebSocket support for real-time updates
- PostgreSQL with connection pooling
- OpenAPI 3.0 documentation
- Comprehensive test suite

## Quick Start

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

The server starts on `http://localhost:3000` with hot reloading enabled.

## API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/auth/login` | Authenticate user | Public |
| POST | `/api/auth/register` | Create new account | Public |
| GET | `/api/users` | List all users | Admin |
| GET | `/api/users/:id` | Get user details | User |
| PUT | `/api/users/:id` | Update user profile | User |
| GET | `/api/projects` | List projects | User |
| POST | `/api/projects` | Create project | User |
| GET | `/api/projects/:id` | Get project details | User |
| DELETE | `/api/projects/:id` | Delete project | Admin |

## Architecture

The application follows a layered architecture:

```
src/
  api/          # Route definitions and request handlers
  auth/         # Authentication strategies and middleware
  models/       # Database models and type definitions
  utils/        # Shared utilities and helpers
  tests/        # Test suites
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `JWT_SECRET` | Secret key for JWT signing | - |
| `REDIS_URL` | Redis connection for rate limiting | - |
| `LOG_LEVEL` | Logging verbosity | `info` |

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

## License

MIT
