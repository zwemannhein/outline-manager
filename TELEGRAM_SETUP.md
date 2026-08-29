# Telegram Bot Setup Guide

## Overview
This guide will help you set up a Telegram bot to receive order notifications and approve/reject orders directly from Telegram.

## Features
- 🔔 Instant notifications when new orders are placed
- ✅ Approve orders with one click
- ❌ Reject orders with one click
- 🔑 Automatic access key creation on approval
- 📱 Manage orders from your phone

## Step 1: Create a Telegram Bot

1. **Open Telegram** and search for `@BotFather`
2. **Start a chat** with BotFather
3. **Send** `/newbot` command
4. **Choose a name** for your bot (e.g., "VPN Order Manager")
5. **Choose a username** for your bot (must end with 'bot', e.g., "vpn_order_manager_bot")
6. **Copy the bot token** - it looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

## Step 2: Get Your Chat ID

### Method 1: Using @userinfobot
1. **Search for** `@userinfobot` on Telegram
2. **Start a chat** and send any message
3. **Copy your ID** - it's a number like `123456789`

### Method 2: Using your bot
1. **Search for your bot** by username
2. **Start a chat** and send `/start`
3. **Visit** `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. **Find** `"chat":{"id":123456789}` in the response
5. **Copy the chat ID**

## Step 3: Set Webhook URL

You need to tell Telegram where to send updates when buttons are clicked.

### For Production (Vercel)
After deploying to Vercel, set the webhook:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-domain.vercel.app/api/v1/telegram/webhook"}'
```

Replace:
- `<YOUR_BOT_TOKEN>` with your actual bot token
- `your-domain.vercel.app` with your actual Vercel domain

### For Development (ngrok)
If testing locally, use ngrok to expose your local server:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000

# Copy the HTTPS URL (e.g., https://abc123.ngrok.io)
# Then set webhook:
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://abc123.ngrok.io/api/v1/telegram/webhook"}'
```

### Verify Webhook
Check if webhook is set correctly:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

## Step 4: Add Environment Variables

### Local Development (.env)
Add to your `.env` file:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

### Vercel Production
Add environment variables in Vercel dashboard:

1. Go to your project on Vercel
2. Click **Settings** → **Environment Variables**
3. Add:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `TELEGRAM_CHAT_ID` = your chat ID
4. **Redeploy** your application

## Step 5: Test the Integration

1. **Place a test order** on your website
2. **Check Telegram** - you should receive a notification with buttons
3. **Click "Approve"** or "Reject"**
4. **Verify** the order status changes in the admin panel

## How It Works

### Order Flow
```
1. Customer places order
   ↓
2. Order saved to database
   ↓
3. Telegram notification sent with buttons
   ↓
4. Admin clicks Approve/Reject in Telegram
   ↓
5. Webhook receives callback
   ↓
6. Order processed (key created if approved)
   ↓
7. Confirmation sent to Telegram
```

### Notification Format
```
🔔 New VPN Order

👤 Customer: John Doe
💳 KPay Ref: KP123456789
📦 Plan: 20GB
🕐 Time: 5/6/2026, 10:30:00 AM

[✅ Approve] [❌ Reject]
```

### After Approval
```
✅ Order Approved

👤 Customer: John Doe
🔑 Access Key Created

ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTp...

The customer has been notified.
```

## Troubleshooting

### Not Receiving Notifications

**Check bot token:**
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe"
```
Should return bot info.

**Check webhook:**
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```
Should show your webhook URL.

**Check environment variables:**
- Verify `TELEGRAM_BOT_TOKEN` is set
- Verify `TELEGRAM_CHAT_ID` is set
- Restart your application after adding variables

**Check logs:**
- Look for `[Telegram]` messages in your application logs
- Check Vercel function logs if deployed

### Buttons Not Working

**Verify webhook is set:**
The webhook must be set for buttons to work. Check with:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

**Check webhook URL:**
- Must be HTTPS (not HTTP)
- Must be publicly accessible
- Must end with `/api/v1/telegram/webhook`

**Test webhook manually:**
```bash
curl -X POST "https://your-domain.vercel.app/api/v1/telegram/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 123,
    "callback_query": {
      "id": "test",
      "from": {"id": YOUR_CHAT_ID, "first_name": "Test"},
      "message": {"message_id": 1, "chat": {"id": YOUR_CHAT_ID}},
      "data": "approve_test_order_id"
    }
  }'
```

### Wrong Chat ID

If you get "Unauthorized" errors:
- Verify your chat ID is correct
- Make sure you've started a chat with your bot
- Check that `TELEGRAM_CHAT_ID` matches your actual chat ID

## Security Notes

1. **Keep bot token secret** - Never commit it to git
2. **Verify chat ID** - Only your chat ID can approve/reject orders
3. **Use HTTPS** - Telegram requires HTTPS for webhooks
4. **Monitor logs** - Check for unauthorized access attempts

## Optional: Disable Telegram

If you don't want to use Telegram, simply don't set the environment variables:
- Orders will still work normally
- You can approve/reject from the web admin panel
- No notifications will be sent

## Advanced Configuration

### Multiple Admins
To allow multiple admins, you can:
1. Create a Telegram group
2. Add your bot to the group
3. Use the group chat ID instead of personal chat ID

### Custom Messages
Edit `lib/telegram.ts` to customize notification messages:
- Change emoji
- Add more details
- Modify button text

### Auto-Approval Rules
You can add logic in `app/api/v1/orders/route.ts` to auto-approve certain orders:
```typescript
// Example: Auto-approve orders under 10GB
if (order.plan === "10gb") {
  // Auto-approve logic here
}
```

## Support

If you need help:
1. Check the logs for error messages
2. Verify all environment variables are set
3. Test the webhook URL manually
4. Check Telegram Bot API documentation: https://core.telegram.org/bots/api

---

**Status**: ✅ Telegram integration ready
**Version**: 1.0.0
**Last Updated**: May 6, 2026
