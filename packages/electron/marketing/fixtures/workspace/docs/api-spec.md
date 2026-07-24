# API Specification

## Authentication

All API endpoints (except `/health` and `/api/auth/*`) require authentication via one of:

- **Bearer Token**: `Authorization: Bearer <jwt_token>`
- **API Key**: `X-API-Key: <api_key>`

## Endpoints

### POST /api/auth/login

Authenticate a user and receive a token pair.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

**Response (200):**
```json
{
  "accessToken": "eyJhbGci...",
  "refreshToken": "dGhpcyBp...",
  "expiresIn": 900
}
```

### GET /api/users

List all users. **Requires admin role.**

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `limit` | number | 20 | Items per page |
| `role` | string | - | Filter by role |

**Response (200):**
```json
{
  "users": [
    { "id": "u_001", "email": "alice@acme.dev", "name": "Alice Chen", "role": "admin" }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 42 }
}
```

### POST /api/projects

Create a new project.

**Request:**
```json
{
  "name": "My Project",
  "description": "A new project",
  "visibility": "private"
}
```

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "NotFoundError",
  "message": "User u_999 not found",
  "statusCode": 404
}
```

## Rate Limiting

- **Window**: 60 seconds
- **Max requests**: 100 per window per IP
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
