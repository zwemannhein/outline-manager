#!/bin/bash

echo "🚀 Outline VPN Manager - Setup & Run"
echo "===================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "📦 Node.js not found. Installing..."
    brew install node@20
    echo "✅ Node.js installed!"
else
    echo "✅ Node.js already installed: $(node --version)"
fi

echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "📝 Setting up environment..."

if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env file"
    echo ""
    echo "⚠️  IMPORTANT: You need to edit .env and set:"
    echo "   1. ADMIN_USERNAME (your admin username)"
    echo "   2. ADMIN_PASSWORD (min 8 characters)"
    echo "   3. JWT_SECRET (run: openssl rand -base64 32)"
    echo "   4. UPSTASH_REDIS_REST_URL (get from upstash.com)"
    echo "   5. UPSTASH_REDIS_REST_TOKEN (get from upstash.com)"
    echo ""
    echo "After editing .env, run this script again."
    exit 0
else
    echo "✅ .env file exists"
fi

echo ""
echo "🔍 Checking environment configuration..."

# Check if required variables are set
if grep -q "your_admin_username" .env || grep -q "your_jwt_secret" .env; then
    echo "⚠️  WARNING: .env still has placeholder values!"
    echo "   Please edit .env and set real values."
    echo ""
    echo "Quick setup:"
    echo "   1. Generate JWT secret: openssl rand -base64 32"
    echo "   2. Get Redis from: https://upstash.com/"
    echo "   3. Edit .env with your values"
    echo ""
    exit 1
fi

echo "✅ Environment configured"
echo ""

echo "🏗️  Building application..."
npm run build

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 Starting server..."
echo "   Open http://localhost:3000 in your browser"
echo ""

npm start
