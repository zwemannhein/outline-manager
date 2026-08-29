# Application Monitoring & Error Handling

## Overview
Comprehensive monitoring and error handling has been implemented across all critical components of the Outline VPN Manager application.

## Fixed Issues

### 1. Orders Panel Authentication Error ✅
**Problem**: Orders tab showed "Something went wrong" with 401 authentication error
**Root Cause**: Using old `/api/orders` endpoint instead of new `/api/v1/orders`
**Solution**: Updated all order endpoints to use v1 API routes
- `/api/orders` → `/api/v1/orders`
- `/api/orders/{id}/approve` → `/api/v1/orders/{id}/approve`
- `/api/orders/{id}/reject` → `/api/v1/orders/{id}/reject`

## Monitoring Features Added

### 1. Console Logging
All critical operations now log to browser console with timestamps and performance metrics:

#### ServerDashboard
```javascript
[ServerDashboard] Loading server: amt 3 (abc-123)
[ServerDashboard] Loaded successfully in 1250ms - 15 keys
[ServerDashboard] Creating key: John's Key
[ServerDashboard] Key created successfully: 16
[ServerDashboard] Deleting key: 5
[ServerDashboard] Key deleted successfully: 5
```

#### OrdersPanel
```javascript
[OrdersPanel] Load error: Authentication failed. Please log in again.
[OrdersPanel] Approve error: Network error
[OrdersPanel] Reject error: Server returned 500
```

#### UserView
```javascript
[UserView] Loading key status for: 52.197.178.179
[UserView] Key status loaded successfully in 850ms
[UserView] Key check failed (404) in 500ms: Server not found
[UserView] Network error after 5000ms: Failed to fetch
```

### 2. Error States with UI Feedback

#### OrdersPanel Error Banner
- Shows error message with icon
- Displays retry button
- Auto-clears on successful retry
- Styled with gradient theme

#### ServerDashboard Error Handling
- Loading state with spinner
- Error state with retry button
- Connection timeout detection
- Server offline detection

#### UserView Error States
- Server not configured (amber warning)
- Network errors (red error)
- Loading states with gradient spinner
- Retry functionality

### 3. Performance Monitoring
All API calls now track:
- **Start time**: When request begins
- **End time**: When request completes
- **Duration**: Total time in milliseconds
- **Success/Failure**: Operation outcome

Example output:
```
[ServerDashboard] Loaded successfully in 1250ms - 15 keys
[UserView] Key status loaded successfully in 850ms
[UserView] Key check failed (404) in 500ms: Server not found
```

### 4. Error Recovery
All components implement graceful error recovery:
- **Retry buttons**: User can manually retry failed operations
- **Auto-refresh**: Some components auto-retry on mount
- **Fallback states**: Meaningful error messages instead of crashes
- **Toast notifications**: User-friendly error messages

## Component-Specific Monitoring

### OrdersPanel (`components/admin/OrdersPanel.tsx`)
**Monitored Operations**:
- ✅ Load orders from API
- ✅ Approve order with key creation
- ✅ Reject order
- ✅ Authentication failures
- ✅ Network errors

**Error Handling**:
- 401 errors → "Authentication failed. Please log in again."
- Network errors → "Network error" with retry
- Server errors → HTTP status code displayed
- Error banner with retry button

**UI States**:
- Loading: Gradient spinner with "Loading orders..."
- Error: Red banner with error message and retry button
- Empty: Gradient icon with "No orders yet"
- Success: Orders displayed in cards

### ServerDashboard (`components/admin/ServerDashboard.tsx`)
**Monitored Operations**:
- ✅ Load server info, keys, and metrics
- ✅ Create access key
- ✅ Delete access key
- ✅ Rename access key
- ✅ Set/remove data limit
- ✅ Set/remove expiry date

**Performance Tracking**:
- Server load time (info + keys + metrics)
- Individual operation timing
- Key count tracking

**Error Handling**:
- Connection failures → Server offline state
- Timeout errors → Retry with exponential backoff
- Operation failures → Toast notification with error

### UserView (`components/user/UserView.tsx`)
**Monitored Operations**:
- ✅ Load key status
- ✅ Check data usage
- ✅ Verify expiry date
- ✅ Switch to different key

**Error States**:
- Server not configured (404) → Amber warning
- Network errors → Red error with retry
- Invalid key → Decode error message

**Performance Tracking**:
- Key check API call duration
- Success/failure rates
- Server response times

### AdminView (`components/admin/AdminView.tsx`)
**Monitored Operations**:
- ✅ Sync server list from KV
- ✅ Add/remove servers
- ✅ Rename servers
- ✅ Tab switching (Servers/Orders)

**Error Handling**:
- KV sync failures → Fallback to local storage
- Empty state → "Add your first server" prompt

## API Endpoints Monitoring

### V1 Endpoints (with auth)
- `/api/v1/orders` - GET (list orders)
- `/api/v1/orders/{id}/approve` - POST (approve order)
- `/api/v1/orders/{id}/reject` - POST (reject order)
- `/api/v1/orders/{id}/status` - GET (check order status)
- `/api/v1/store` - GET (get admin data)

### Public Endpoints (no auth)
- `/api/v1/key-check` - POST (check key status)
- `/api/v1/health` - GET (health check)

## Error Types Tracked

### 1. Authentication Errors (401)
- Missing or invalid JWT token
- Expired session
- Wrong credentials

**User Action**: Redirect to login or show "Please log in again"

### 2. Authorization Errors (403)
- Insufficient permissions
- Rate limit exceeded

**User Action**: Show error message, disable action

### 3. Not Found Errors (404)
- Server not configured
- Order not found
- Key not found

**User Action**: Show specific "not found" message

### 4. Server Errors (500)
- Outline server unreachable
- Database errors
- Internal server errors

**User Action**: Show error with retry button

### 5. Network Errors
- Connection timeout
- DNS resolution failure
- Network unreachable

**User Action**: Show network error with retry

### 6. Validation Errors (400)
- Invalid input data
- Missing required fields
- Malformed requests

**User Action**: Show validation error message

## Monitoring Best Practices

### 1. Console Logging Format
```javascript
console.log(`[ComponentName] Action: details`);
console.error(`[ComponentName] Error type:`, error);
```

### 2. Performance Tracking
```javascript
const startTime = Date.now();
// ... operation ...
const duration = Date.now() - startTime;
console.log(`[Component] Operation completed in ${duration}ms`);
```

### 3. Error Context
Always include:
- Component name
- Operation being performed
- Error message
- Relevant IDs or data

### 4. User Feedback
- Toast notifications for operations
- Error banners for persistent errors
- Loading states for async operations
- Success confirmations

## Future Enhancements

### 1. Centralized Error Tracking
- Implement error tracking service (e.g., Sentry)
- Aggregate errors by type and frequency
- Alert on critical errors

### 2. Performance Metrics Dashboard
- Average API response times
- Success/failure rates
- User action tracking
- Server health metrics

### 3. Real-time Monitoring
- WebSocket connection status
- Live server health checks
- Real-time order notifications
- Key usage alerts

### 4. Analytics
- User behavior tracking
- Feature usage statistics
- Error rate trends
- Performance bottlenecks

### 5. Automated Alerts
- Email notifications for critical errors
- Slack/Discord webhooks for order approvals
- SMS alerts for server downtime
- Dashboard for admin monitoring

## Testing Monitoring

### How to Test Error Handling

1. **Network Errors**:
   - Disconnect internet
   - Try to load orders/keys
   - Verify error message and retry button

2. **Authentication Errors**:
   - Clear session storage
   - Try to access orders tab
   - Verify 401 error handling

3. **Server Errors**:
   - Stop Outline server
   - Try to load keys
   - Verify offline state

4. **Validation Errors**:
   - Submit invalid data
   - Verify validation error messages

### Console Monitoring
Open browser DevTools (F12) → Console tab to see all monitoring logs:
- Blue: Info logs
- Yellow: Warning logs
- Red: Error logs

### Network Monitoring
Open browser DevTools (F12) → Network tab to see:
- API request/response times
- HTTP status codes
- Request/response payloads
- Failed requests

## Summary

✅ **Fixed**: Orders panel 401 authentication error
✅ **Added**: Comprehensive console logging
✅ **Added**: Performance tracking for all operations
✅ **Added**: Error states with retry functionality
✅ **Added**: User-friendly error messages
✅ **Added**: Loading states with gradient spinners
✅ **Improved**: Error recovery mechanisms
✅ **Improved**: User feedback with toasts and banners

All critical components now have robust error handling and monitoring capabilities for production use.
