# Outline VPN Manager

A production-ready, centralized web-based management platform for self-hosted Outline VPN servers with integrated order management and KPay payment system.

## ✨ Features

### For Public Users
- 📱 Browse and order VPN plans (fixed or custom)
- 💳 KPay payment integration
- ⏱️ Real-time order status tracking
- 🔍 Check key status, data usage, and expiry
- 📋 Easy key copying and management

### For Administrators
- 🖥️ Manage multiple Outline servers
- 📊 Real-time metrics and data usage
- 🔑 Create, rename, delete access keys
- 💾 Set per-key data limits and expiry dates
- ✅ Approve/reject customer orders
- 🔄 Cross-device sync via Redis
- 📴 Offline fallback to localStorage

### Security & Performance
- 🔐 JWT-based authentication
- 🛡️ Rate limiting on all public endpoints
- ✅ Input validation with Zod
- 📝 Structured logging with Pino
- 🚀 Response caching
- 📈 Exponential backoff polling
- 🎯 Certificate pinning for Outline API

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Upstash Redis or Vercel KV account
- Outline VPN server(s)

### Installation

1. **Clone the repository**:
   ```bash
   git clone <your-repo-url>
   cd outline-vpn-manager
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set:
   ```env
   # Admin Credentials (REQUIRED)
   ADMIN_USERNAME=your_admin_username
   ADMIN_PASSWORD=your_secure_password_min_8_chars

   # JWT Secret (REQUIRED) - Generate with: openssl rand -base64 32
   JWT_SECRET=your_jwt_secret_at_least_32_characters_long

   # Redis Configuration (REQUIRED)
   UPSTASH_REDIS_REST_URL=https://your-redis-instance.upstash.io
   UPSTASH_REDIS_REST_TOKEN=your_redis_token
   ```

4. **Run development server**:
   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000)

5. **Build for production**:
   ```bash
   npm run build
   npm start
   ```

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests with UI
npm run test:ui

# Type checking
npm run type-check

# Linting
npm run lint
```

## 📚 API Documentation

### Public Endpoints

#### Submit Order
```http
POST /api/v1/orders
Content-Type: application/json

{
  "name": "John Doe",
  "kpayRef": "123456",
  "plan": "plan_a"
}
```

**Rate Limit**: 3 requests per hour per IP

#### Check Order Status
```http
GET /api/v1/orders/{orderId}/status
```

**Rate Limit**: 20 requests per minute per IP

#### Check Key Status
```http
POST /api/v1/key-check
Content-Type: application/json

{
  "ssHost": "example.com",
  "keyId": "123",
  "password": "secret"
}
```

**Rate Limit**: 10 requests per minute per IP  
**Cache**: 60 seconds

### Admin Endpoints

All admin endpoints require JWT authentication via `Authorization: Bearer <token>` header.

#### Login
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "password"
}
```

**Rate Limit**: 5 requests per 15 minutes per IP

**Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "24h",
  "username": "admin"
}
```

#### List Orders
```http
GET /api/v1/orders
Authorization: Bearer <token>
```

#### Approve Order
```http
POST /api/v1/orders/{orderId}/approve
Authorization: Bearer <token>
Content-Type: application/json

{
  "serverId": "optional-server-id"
}
```

#### Reject Order
```http
POST /api/v1/orders/{orderId}/reject
Authorization: Bearer <token>
```

#### Get/Save Admin Data
```http
GET /api/v1/store
Authorization: Bearer <token>

POST /api/v1/store
Authorization: Bearer <token>
Content-Type: application/json

{
  "servers": [...],
  "keyMeta": {...}
}
```

### Health Check
```http
GET /api/v1/health
```

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 12345,
  "redis": "healthy"
}
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Application                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────┐ │
│  │   Public User    │  │   Admin User     │  │ User View  │ │
│  │   (OrderForm)    │  │  (AdminView)     │  │ (MyKey)    │ │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬───┘ │
│           │                     │                     │      │
│           └─────────────────────┼─────────────────────┘      │
│                                 │                             │
│                    ┌────────────▼────────────┐               │
│                    │   API Routes (v1)       │               │
│                    ├────────────────────────┤               │
│                    │ • Auth (JWT)            │               │
│                    │ • Orders (CRUD)         │               │
│                    │ • Key Check (cached)    │               │
│                    │ • Store (sync)          │               │
│                    │ • Health                │               │
│                    └────────────┬───────────┘               │
│                                 │                             │
│        ┌────────────────────────┼────────────────────────┐   │
│        │                        │                        │   │
│   ┌────▼────┐          ┌────────▼────────┐      ┌───────▼──┐│
│   │ Upstash │          │ Outline Client  │      │ Storage  ││
│   │ Redis   │          │ (HTTPS + Cert   │      │ (Local)  ││
│   │ + Rate  │          │  Pinning)       │      │          ││
│   │ Limit   │          │                 │      │          ││
│   └─────────┘          └─────────────────┘      └──────────┘│
└─────────────────────────────────────────────────────────────┘
```

## 🔒 Security Features

1. **JWT Authentication**: Secure token-based auth with 24h expiration
2. **Rate Limiting**: Prevents abuse and DDoS attacks
3. **Input Validation**: Zod schemas prevent injection attacks
4. **Certificate Pinning**: Validates Outline server certificates
5. **Environment Validation**: Fails fast if misconfigured
6. **Structured Error Handling**: No sensitive data in error messages
7. **HTTPS Only**: All external API calls use HTTPS

## 📊 Monitoring

### Logs

Structured JSON logs with levels:
- `debug`: Detailed debugging information
- `info`: Normal operations (login, order created, etc.)
- `warn`: Rate limits, failed auth attempts
- `error`: Unexpected errors, API failures

### Health Check

Monitor application health at `/api/v1/health`:
- Server uptime
- Redis connectivity
- Timestamp

### Metrics

Rate limiting provides built-in analytics:
- Request counts per endpoint
- Rate limit hits
- IP-based tracking

## 🛠️ Development

### Project Structure

```
outline-vpn-manager/
├── app/
│   ├── api/v1/          # API routes (versioned)
│   │   ├── auth/        # Authentication
│   │   ├── orders/      # Order management
│   │   ├── key-check/   # Key status
│   │   ├── store/       # Admin data sync
│   │   └── health/      # Health check
│   ├── globals.css      # Global styles
│   ├── layout.tsx       # Root layout
│   └── page.tsx         # Main page
├── components/
│   ├── admin/           # Admin components
│   ├── ui/              # Reusable UI components
│   ├── user/            # User components
│   ├── AdminLoginForm.tsx
│   ├── ErrorBoundary.tsx
│   └── OrderForm.tsx
├── lib/
│   ├── api-utils.ts     # Shared API utilities
│   ├── logger.ts        # Structured logging
│   ├── outline-client.ts # Outline API client
│   ├── polling.ts       # Exponential backoff
│   ├── ss-decoder.ts    # Shadowsocks URL parser
│   ├── storage.ts       # Local storage helpers
│   ├── sync.ts          # Server sync
│   ├── types.ts         # TypeScript types
│   ├── utils.ts         # Utility functions
│   └── validation.ts    # Zod schemas
├── __tests__/           # Test files
├── .github/workflows/   # CI/CD
└── ...
```

### Adding a New API Endpoint

1. Create route file in `app/api/v1/your-endpoint/route.ts`
2. Import utilities from `lib/api-utils.ts`
3. Add validation schema to `lib/validation.ts`
4. Implement handler with error handling
5. Add tests in `__tests__/`

Example:
```typescript
import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-utils";

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    // Your logic here

    return successResponse({ data: "result" });
  } catch (error) {
    return handleApiError(error);
  }
}
```

## 🚢 Deployment

### Vercel (Recommended)

1. Push to GitHub
2. Import project in Vercel
3. Add environment variables
4. Deploy

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### Environment Variables

Required for production:
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD` (min 8 chars)
- `JWT_SECRET` (min 32 chars)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `NODE_ENV=production`

## 📖 Documentation

- [Improvements Made](./IMPROVEMENTS.md) - Detailed list of all improvements
- [API Documentation](#-api-documentation) - API reference
- [Architecture](#-architecture) - System design

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Standards

- Run `npm run lint` before committing
- Run `npm run type-check` to verify types
- Add tests for new features
- Follow existing code style

## 📄 License

This project is licensed under the MIT License.

## 🙏 Acknowledgments

- [Outline VPN](https://getoutline.org/) - VPN server software
- [Next.js](https://nextjs.org/) - React framework
- [Upstash](https://upstash.com/) - Redis and rate limiting
- [Radix UI](https://www.radix-ui.com/) - UI components
- [Tailwind CSS](https://tailwindcss.com/) - Styling

## 📞 Support

For issues and questions:
- Open an issue on GitHub
- Check existing documentation
- Review [IMPROVEMENTS.md](./IMPROVEMENTS.md) for recent changes

---

**Built with ❤️ for secure, scalable VPN management**
