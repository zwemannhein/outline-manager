# 🚀 START HERE - Run Your Application

## Option 1: Automatic Setup (Recommended)

Just run this one command:

```bash
./setup-and-run.sh
```

This will:
1. ✅ Install Node.js (if needed)
2. ✅ Install all dependencies
3. ✅ Create .env file
4. ✅ Build the application
5. ✅ Start the server

---

## Option 2: Manual Setup

### Step 1: Install Node.js
```bash
brew install node@20
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Configure Environment
```bash
# Copy example file
cp .env.example .env

# Generate JWT secret
openssl rand -base64 32

# Edit .env and paste the values
nano .env
```

**Required values in .env:**
```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=yourpassword123
JWT_SECRET=<paste the generated secret>
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token
```

### Step 4: Run the App
```bash
# Development mode (with auto-reload)
npm run dev

# OR Production mode
npm run build
npm start
```

### Step 5: Open Browser
```
http://localhost:3000
```

---

## 🔑 Getting Redis Credentials

You need a Redis database (it's free!):

1. Go to: https://console.upstash.com/
2. Click "Create Database"
3. Choose "Free" plan
4. Copy the **REST URL** and **REST Token**
5. Paste them into your `.env` file

**Important:** Use the REST URL, not the regular URL!

---

## ✅ Verify It's Working

### Test 1: Health Check
```bash
curl http://localhost:3000/api/v1/health
```

Should show: `"status": "healthy"`

### Test 2: Open in Browser
```
http://localhost:3000
```

You should see the order form!

### Test 3: Admin Login
1. Click "Admin Login" at the bottom
2. Enter your ADMIN_USERNAME and ADMIN_PASSWORD
3. You should see the admin dashboard

---

## 🎯 What You Can Do Now

### As a Customer:
1. Fill out the order form
2. Enter any 6-digit number for KPay (for testing)
3. Submit order
4. Wait for admin approval

### As an Admin:
1. Login with your credentials
2. Add your Outline server
3. View and approve orders
4. Manage VPN keys

### Check Key Status:
1. After getting a key, click "My Key" tab
2. Paste your key
3. See data usage and expiry

---

## 🆘 Troubleshooting

### "npm: command not found"
**Fix:** Install Node.js first
```bash
brew install node@20
```

### "Environment validation failed"
**Fix:** Check your .env file:
- JWT_SECRET must be 32+ characters
- ADMIN_PASSWORD must be 8+ characters
- Redis URL must start with https://

### "Port 3000 already in use"
**Fix:** Kill the process or use different port
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or use different port
PORT=3001 npm run dev
```

### "Redis connection failed"
**Fix:** 
1. Check your Redis credentials in .env
2. Make sure you're using REST URL (not regular URL)
3. Test: `curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/ping"`

---

## 📚 More Help

- **Quick Start:** See QUICK_START.md
- **Full Documentation:** See README.md
- **What Changed:** See IMPROVEMENTS.md
- **Deployment:** See DEPLOYMENT_CHECKLIST.md

---

## 🎉 Quick Start Commands

```bash
# One-line setup (if you have everything ready)
npm install && cp .env.example .env && npm run dev

# Then edit .env with your values and restart
```

---

**Need help?** Check the documentation files or open an issue on GitHub.

**Ready to deploy?** See DEPLOYMENT_CHECKLIST.md for production setup.
