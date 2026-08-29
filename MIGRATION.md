# Migration Guide

This guide helps you migrate from the old version to the new improved version with JWT authentication, rate limiting, and API versioning.

## Overview

The new version includes:
- JWT authentication (replacing base64 credentials)
- API versioning (`/api/v1/*`)
- Rate limiting
- Input validation
- Structured logging
- Caching
- Exponential backoff polling

## Step-by-Step Migration

### 1. Backup Your Data

Before starting, backup your Redis data:

```bash
# If using Upstash, export via dashboard
# Or backup your .env file
cp .env .env.backup
```

### 2. Update Dependencies

```bash
npm install
```

This will install new dependencies:
- `@upstash/ratelimit` - Rate limiting
- `jose` - JWT handling
- `pino` - Structured logging
- `zod` - Input validation
- `vitest` - Testing framework

### 3. Update Environment Variables

Add new required variables to your `.env`:

```bash
# Generate a secure JWT secret (32+ characters)
openssl rand -base64 32

# Add to .env
JWT_SECRET=<generated-secret>

# Ensure password is at least 8 characters
ADMIN_PASSWORD=<your-secure-password>
```

**Required variables**:
```env
ADMIN_USERNAME=your_admin_username
ADMIN_PASSWORD=your_secure_password_min_8_chars  # Min 8 chars
JWT_SECRET=your_jwt_secret_at_least_32_characters_long  # Min 32 chars
UPSTASH_REDIS_REST_URL=https://your-redis-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_redis_token
NODE_ENV=production
```

### 4. Test Locally

```bash
# Type check
npm run type-check

# Lint
npm run lint

# Run tests
npm test

# Build
npm run build

# Start
npm start
```

### 5. Update Client Code (If Applicable)

If you have external clients calling your API, update the endpoints:

#### Old Endpoints (Still Work for Backward Compatibility)
```
POST /api/orders
GET  /api/orders/{id}/status
POST /api/key-check
GET  /api/store
POST /api/store
```

#### New Endpoints (Recommended)
```
POST /api/v1/orders
GET  /api/v1/orders/{id}/status
POST /api/v1/key-check
GET  /api/v1/store
POST /api/v1/store
```

#### Authentication Changes

**Old (Basic Auth)**:
```javascript
const credentials = btoa(`${username}:${password}`);
fetch('/api/orders', {
  headers: {
    'Authorization': `Bearer ${credentials}`
  }
});
```

**New (JWT)**:
```javascript
// 1. Login to get token
const loginRes = await fetch('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
});
const { token } = await loginRes.json();

// 2. Use token for authenticated requests
fetch('/api/v1/orders', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

### 6. Deploy

#### Vercel
1. Update environment variables in Vercel dashboard
2. Push to GitHub
3. Vercel will auto-deploy

#### Docker
```bash
docker build -t outline-vpn-manager .
docker run -p 3000:3000 --env-file .env outline-vpn-manager
```

#### Manual
```bash
npm run build
npm start
```

### 7. Verify Deployment

Check health endpoint:
```bash
curl https://your-domain.com/api/v1/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 12345,
  "redis": "healthy"
}
```

### 8. Monitor Logs

Check application logs for any errors:

```bash
# Vercel
vercel logs

# Docker
docker logs <container-id>

# PM2
pm2 logs
```

## Breaking Changes

### 1. Authentication
- Old: Base64-encoded credentials
- New: JWT tokens with expiration
- **Action**: Update client code to use `/api/v1/auth/login`

### 2. API Versioning
- Old: `/api/orders`
- New: `/api/v1/orders`
- **Action**: Update API calls (old endpoints still work)

### 3. Rate Limiting
- New: All public endpoints have rate limits
- **Action**: Handle 429 responses in client code

### 4. Error Responses
- Old: Inconsistent error formats
- New: Structured errors with codes
- **Action**: Update error handling to check `error.code`

Example:
```javascript
try {
  const res = await fetch('/api/v1/orders', { ... });
  const data = await res.json();
  
  if (!res.ok) {
    // New structured error
    console.error(data.error);  // Human-readable message
    console.error(data.code);   // Machine-readable code
    console.error(data.details); // Additional context
  }
} catch (error) {
  // Network error
}
```

## Rollback Plan

If you need to rollback:

1. **Revert code**:
   ```bash
   git revert HEAD
   git push
   ```

2. **Restore environment**:
   ```bash
   cp .env.backup .env
   ```

3. **Redeploy**:
   ```bash
   npm run build
   npm start
   ```

## Common Issues

### Issue: "Environment validation failed"

**Cause**: Missing or invalid environment variables

**Solution**:
```bash
# Check .env file
cat .env

# Ensure all required variables are set
# JWT_SECRET must be at least 32 characters
# ADMIN_PASSWORD must be at least 8 characters
```

### Issue: "Redis connection failed"

**Cause**: Invalid Redis credentials

**Solution**:
```bash
# Verify Redis URL and token
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/ping"
```

### Issue: "Rate limit exceeded"

**Cause**: Too many requests from same IP

**Solution**:
- Wait for rate limit window to reset
- Check `Retry-After` header in response
- Implement exponential backoff in client

### Issue: "Invalid token"

**Cause**: JWT token expired or invalid

**Solution**:
```javascript
// Check token expiration
const payload = JSON.parse(atob(token.split('.')[1]));
console.log('Expires:', new Date(payload.exp * 1000));

// Re-login if expired
if (Date.now() > payload.exp * 1000) {
  await login(username, password);
}
```

## Testing Checklist

After migration, verify:

- [ ] Admin can login with new JWT auth
- [ ] Public users can submit orders
- [ ] Order status polling works
- [ ] Key check works
- [ ] Admin can approve/reject orders
- [ ] Server management works
- [ ] Cross-device sync works
- [ ] Rate limiting is active
- [ ] Health check returns 200
- [ ] Logs are structured and readable

## Support

If you encounter issues:

1. Check logs for error messages
2. Verify environment variables
3. Test health endpoint
4. Review [IMPROVEMENTS.md](./IMPROVEMENTS.md)
5. Open an issue on GitHub

## Next Steps

After successful migration:

1. **Remove old API routes** (optional):
   - Delete `app/api/orders/route.ts` (old version)
   - Delete `app/api/store/route.ts` (old version)
   - Keep only v1 routes

2. **Set up monitoring**:
   - Integrate with Sentry for error tracking
   - Set up log aggregation (Datadog, Splunk, etc.)
   - Configure uptime monitoring

3. **Enable CI/CD**:
   - GitHub Actions workflow is already configured
   - Add deployment secrets to GitHub

4. **Review security**:
   - Rotate JWT secret regularly
   - Use strong admin password
   - Enable 2FA for admin (future feature)

---

**Migration completed successfully? Great! Your application is now more secure, performant, and maintainable.**
