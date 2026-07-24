# Changelog

## [2.4.1] - 2025-02-15

### Fixed
- Rate limiter not resetting counters after window expiry
- WebSocket reconnection dropping messages during handshake

## [2.4.0] - 2025-02-10

### Added
- API key authentication strategy alongside JWT
- Rate limiting headers in all responses
- Health check endpoint at `/health`

### Changed
- Auth middleware now uses strategy pattern for extensibility
- Improved error messages for authentication failures

## [2.3.0] - 2025-01-28

### Added
- WebSocket support for real-time project updates
- Cursor-based pagination for user and project list endpoints
- OpenAPI 3.0 documentation generation

### Fixed
- Database connection pool exhaustion under heavy load
- CORS headers missing on error responses

## [2.2.0] - 2025-01-10

### Added
- Role-based access control (RBAC) with admin, user, and viewer roles
- Project management endpoints (CRUD)
- Request body validation with Zod schemas

### Changed
- Migrated from Express 4.17 to 4.18
- Updated all dependencies to latest versions
