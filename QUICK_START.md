# Quick Start Guide

## Prerequisites Installation

### Step 1: Install Node.js

**On macOS:**
```bash
# Using Homebrew (recommended)
brew install node@20

# Or download from: https://nodejs.org/
```

**Verify installation:**
```bash
node --version  # Should show v20.x.x
npm --version   # Should show 10.x.x
```

---

## Step 2: Install Dependencies

```bash
# Install all required packages
npm install
```

This will install:
- Next.js (web framework)
- JWT libraries (authentication)
- Rate limiting (security)
- Validation (input checking)
- Logging (debugging)
- Testing tools

---

## Step 3: Configure Environment

```bash
# Copy the example environment file
cp .env.example .env
```

Now edit `.env` and set these **REQUIRED** values:

```env
# 1. Admin credentials (change these!)
ADMIN_USERNAME=your_username
ADMIN_PASSWORD=your_secure_password_min_8_chars

# 2. Generate JWT secret (run this command):
# openssl rand -base64 32
JWT_SECRET=paste_generated_secret_here

# 3. Redis configuration (get from Upstash.com)
UPSTASH_REDIS_REST_URL=https://your-redis-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_redis_token

# 4. Environment
NODE_ENV=development
```

### How to get Redis credentials:

1. Go to https://upstash.com/
2. Sign up for free account
3. Create a new Redis database
4. Copy the REST URL and Token
5. Paste them into `.env`

---

## Step 4: Run the Application

### Development Mode (with hot reload):
```bash
npm run dev
```

Then open: http://localhost:3000

### Production Mode:
```bash
# Build the application
npm run build

# Start the server
npm start
```

---

## Step 5: Verify Everything Works

### Check Health:
```bash
curl http://localhost:3000/api/v1/health
```

Should return:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 123,
  "redis": "healthy"
}
```

### Test Admin Login:
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"your_username","password":"your_password"}'
```

Should return a JWT token.

---

## Common Issues

### Issue: "npm: command not found"
**Solution:** Install Node.js first (see Step 1)

### Issue: "Environment validation failed"
**Solution:** Make sure all required variables in `.env` are set:
- JWT_SECRET must be at least 32 characters
- ADMIN_PASSWORD must be at least 8 characters
- Redis URL and token must be valid

### Issue: "Redis connection failed"
**Solution:** 
1. Check your Redis credentials
2. Make sure you copied the REST URL (not the regular URL)
3. Test connection: `curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/ping"`

### Issue: Port 3000 already in use
**Solution:** 
```bash
# Kill the process using port 3000
lsof -ti:3000 | xargs kill -9

# Or use a different port
PORT=3001 npm run dev
```

---

## What You'll See

### 1. Public Homepage (http://localhost:3000)
- Order form for customers
- KPay payment details
- Plan selection (Plan A, Plan B, Custom)

### 2. Admin Login (click "Admin Login" at bottom)
- Login with your ADMIN_USERNAME and ADMIN_PASSWORD
- Get JWT token (stored automatically)

### 3. Admin Dashboard
- View all servers
- Manage access keys
- Approve/reject orders
- View metrics

### 4. User View (after order approval)
- Check key status
- View data usage
- See expiry date

---

## Testing the Full Flow

### As a Customer:
1. Open http://localhost:3000
2. Fill in name and KPay reference (any 6 digits for testing)
3. Select a plan
4. Submit order
5. Wait for approval (page auto-refreshes)

### As an Admin:
1. Click "Admin Login"
2. Enter your credentials
3. Go to "Orders" tab
4. Click "Approve" on pending order
5. System creates VPN key automatically

### As a User (checking key):
1. After approval, copy the access key
2. Click "My Key" tab
3. Paste the key
4. See data usage and expiry

---

## Next Steps

1. **Add your Outline server:**
   - Login as admin
   - Click "Add Server"
   - Paste your Outline API URL and certificate fingerprint

2. **Test order approval:**
   - Submit a test order
   - Approve it as admin
   - Verify key is created on Outline server

3. **Monitor logs:**
   ```bash
   # Watch logs in real-time
   npm run dev
   ```

4. **Run tests:**
   ```bash
   npm test
   ```

---

## Production Deployment

### Option 1: Vercel (Easiest)
1. Push code to GitHub
2. Import project in Vercel
3. Add environment variables
4. Deploy automatically

### Option 2: Docker
```bash
docker build -t outline-vpn-manager .
docker run -p 3000:3000 --env-file .env outline-vpn-manager
```

### Option 3: VPS/Server
```bash
# Install dependencies
npm ci --only=production

# Build
npm run build

# Start with PM2
npm install -g pm2
pm2 start npm --name "outline-vpn" -- start
pm2 save
pm2 startup
```

---

## Getting Help

- **Documentation:** See README.md
- **Improvements:** See IMPROVEMENTS.md
- **Migration:** See MIGRATION.md
- **Deployment:** See DEPLOYMENT_CHECKLIST.md

---

## Quick Commands Reference

```bash
# Development
npm run dev              # Start dev server
npm run build            # Build for production
npm start                # Start production server

# Quality
npm run lint             # Check code style
npm run type-check       # Check TypeScript
npm test                 # Run tests

# Utilities
npm run test:ui          # Interactive test UI
```

---

**Ready to start? Run these commands:**

```bash
# 1. Install Node.js (if not installed)
brew install node@20

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your values

# 4. Start the app
npm run dev

# 5. Open browser
open http://localhost:3000
```

🎉 **You're all set!**
