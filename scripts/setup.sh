#!/bin/bash

# Setup script for Outline VPN Manager
# This script helps you set up the application for the first time

set -e

echo "🚀 Outline VPN Manager - Setup Script"
echo "======================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js $(node --version) detected"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ npm $(npm --version) detected"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Dependencies installed"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    
    # Generate JWT secret
    if command -v openssl &> /dev/null; then
        JWT_SECRET=$(openssl rand -base64 32)
        # Replace placeholder in .env
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s|your_jwt_secret_at_least_32_characters_long|$JWT_SECRET|g" .env
        else
            # Linux
            sed -i "s|your_jwt_secret_at_least_32_characters_long|$JWT_SECRET|g" .env
        fi
        echo "✅ Generated JWT secret"
    else
        echo "⚠️  OpenSSL not found. Please manually set JWT_SECRET in .env"
    fi
    
    echo ""
    echo "⚠️  IMPORTANT: Edit .env and set the following:"
    echo "   - ADMIN_USERNAME (your admin username)"
    echo "   - ADMIN_PASSWORD (min 8 characters)"
    echo "   - UPSTASH_REDIS_REST_URL (your Redis URL)"
    echo "   - UPSTASH_REDIS_REST_TOKEN (your Redis token)"
    echo ""
    echo "   JWT_SECRET has been auto-generated."
    echo ""
else
    echo "✅ .env file already exists"
    echo ""
fi

# Run type check
echo "🔍 Running type check..."
npm run type-check

echo ""
echo "✅ Type check passed"
echo ""

# Run linter
echo "🔍 Running linter..."
npm run lint

echo ""
echo "✅ Linter passed"
echo ""

# Run tests
echo "🧪 Running tests..."
npm test

echo ""
echo "✅ Tests passed"
echo ""

# Build
echo "🏗️  Building application..."
npm run build

echo ""
echo "✅ Build successful"
echo ""

echo "======================================"
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env and configure your environment variables"
echo "2. Run 'npm run dev' to start development server"
echo "3. Open http://localhost:3000 in your browser"
echo ""
echo "For production deployment:"
echo "1. Ensure all environment variables are set"
echo "2. Run 'npm run build'"
echo "3. Run 'npm start'"
echo ""
echo "📚 Documentation:"
echo "   - README.md - Project overview"
echo "   - IMPROVEMENTS.md - List of improvements"
echo "   - MIGRATION.md - Migration guide"
echo "   - IMPLEMENTATION_SUMMARY.md - Implementation details"
echo ""
echo "🎉 Happy coding!"
