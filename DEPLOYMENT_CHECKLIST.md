# Deployment Checklist

Use this checklist to ensure a smooth deployment of the improved Outline VPN Manager.

## Pre-Deployment

### Environment Setup
- [ ] Node.js 20+ installed
- [ ] npm or yarn installed
- [ ] Redis/KV account created (Upstash or Vercel)
- [ ] Environment variables prepared

### Code Verification
- [ ] All dependencies installed (`npm install`)
- [ ] Type check passes (`npm run type-check`)
- [ ] Linter passes (`npm run lint`)
- [ ] Tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)

### Configuration
- [ ] `.env` file created from `.env.example`
- [ ] `ADMIN_USERNAME` set (not default)
- [ ] `ADMIN_PASSWORD` set (min 8 chars, strong password)
- [ ] `JWT_SECRET` generated (min 32 chars, use `openssl rand -base64 32`)
- [ ] `UPSTASH_REDIS_REST_URL` configured
- [ ] `UPSTASH_REDIS_REST_TOKEN` configured
- [ ] `NODE_ENV=production` set

### Security Review
- [ ] Admin password is strong (not "<ADMIN_PASSWORD>")
- [ ] JWT secret is random and secure (not a default value)
- [ ] Redis credentials are valid and secure
- [ ] No secrets committed to git
- [ ] `.env` is in `.gitignore`

## Deployment

### Platform-Specific

#### Vercel
- [ ] Project imported to Vercel
- [ ] Environment variables added in Vercel dashboard
- [ ] Build command: `npm run build`
- [ ] Start command: `npm start`
- [ ] Node.js version: 20.x
- [ ] Deploy triggered

#### Docker
- [ ] Dockerfile created
- [ ] Image built: `docker build -t outline-vpn-manager .`
- [ ] Environment variables passed via `--env-file .env`
- [ ] Port 3000 exposed
- [ ] Container started: `docker run -p 3000:3000 --env-file .env outline-vpn-manager`

#### VPS/Dedicated Server
- [ ] Code deployed to server
- [ ] Dependencies installed: `npm ci --only=production`
- [ ] Built: `npm run build`
- [ ] Process manager configured (PM2, systemd, etc.)
- [ ] Reverse proxy configured (nginx, Apache)
- [ ] SSL certificate installed
- [ ] Firewall configured

## Post-Deployment

### Verification
- [ ] Application starts without errors
- [ ] Health check returns 200: `curl https://your-domain.com/api/v1/health`
- [ ] Admin login works
- [ ] Public order form loads
- [ ] Order submission works
- [ ] Order approval works
- [ ] Key check works
- [ ] Rate limiting is active (test by exceeding limits)

### Monitoring Setup
- [ ] Health check endpoint monitored
- [ ] Uptime monitoring configured (UptimeRobot, Pingdom, etc.)
- [ ] Error tracking configured (Sentry, optional)
- [ ] Log aggregation configured (Datadog, Splunk, optional)
- [ ] Alerts configured for downtime

### Documentation
- [ ] Admin credentials documented securely
- [ ] Deployment process documented
- [ ] Rollback procedure documented
- [ ] Team members notified of changes

## Testing in Production

### Functional Tests
- [ ] Admin can login
- [ ] Admin can add server
- [ ] Admin can view keys
- [ ] Admin can create key
- [ ] Admin can approve order
- [ ] Admin can reject order
- [ ] Public user can submit order
- [ ] Public user can check order status
- [ ] Public user can check key status

### Performance Tests
- [ ] Response times acceptable (<500ms for most endpoints)
- [ ] Caching works (check Redis for cached keys)
- [ ] Rate limiting works (test by exceeding limits)
- [ ] Exponential backoff works (check polling intervals)

### Security Tests
- [ ] Cannot access admin endpoints without token
- [ ] Token expires after 24 hours
- [ ] Rate limits prevent abuse
- [ ] Invalid inputs are rejected
- [ ] Error messages don't leak sensitive data

## Migration (If Upgrading)

### Pre-Migration
- [ ] Backup Redis data
- [ ] Backup `.env` file
- [ ] Document current admin credentials
- [ ] Test migration in staging environment

### Migration Steps
- [ ] Follow [MIGRATION.md](./MIGRATION.md)
- [ ] Update environment variables
- [ ] Deploy new version
- [ ] Verify all functionality
- [ ] Update client code (if applicable)

### Post-Migration
- [ ] Old admin credentials still work
- [ ] Existing orders are accessible
- [ ] Existing keys are accessible
- [ ] No data loss
- [ ] Performance improved

## Rollback Plan

### If Issues Occur
- [ ] Rollback procedure documented
- [ ] Previous version available
- [ ] Database backup available
- [ ] Team knows how to rollback

### Rollback Steps
1. Stop current deployment
2. Restore previous version
3. Restore environment variables
4. Restart application
5. Verify functionality
6. Notify team

## Maintenance

### Regular Tasks
- [ ] Monitor logs daily
- [ ] Check health endpoint hourly (automated)
- [ ] Review rate limit metrics weekly
- [ ] Update dependencies monthly
- [ ] Rotate JWT secret quarterly
- [ ] Review security quarterly

### Backup Schedule
- [ ] Redis data backed up daily
- [ ] Environment variables backed up
- [ ] Code repository backed up (git)

## Support

### Contact Information
- [ ] Admin contact documented
- [ ] Support email configured
- [ ] Escalation procedure documented

### Resources
- [ ] README.md accessible
- [ ] IMPROVEMENTS.md accessible
- [ ] MIGRATION.md accessible
- [ ] API documentation accessible

## Sign-Off

### Deployment Team
- [ ] Developer: _________________ Date: _______
- [ ] DevOps: _________________ Date: _______
- [ ] QA: _________________ Date: _______
- [ ] Manager: _________________ Date: _______

### Notes
```
Add any deployment-specific notes here:
- 
- 
- 
```

---

## Quick Commands Reference

```bash
# Health check
curl https://your-domain.com/api/v1/health

# Test login
curl -X POST https://your-domain.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password"}'

# Check logs (Vercel)
vercel logs

# Check logs (Docker)
docker logs <container-id>

# Check logs (PM2)
pm2 logs

# Restart (PM2)
pm2 restart outline-vpn-manager

# Restart (Docker)
docker restart <container-id>

# Restart (systemd)
sudo systemctl restart outline-vpn-manager
```

---

**Deployment Status**: ⬜ Not Started | 🟡 In Progress | ✅ Complete

**Deployment Date**: _______________

**Deployed By**: _______________

**Production URL**: _______________
