# Telegram Bot - Quick Start

## ⚡ 5-Minute Setup

### 1. Create Bot (2 minutes)
1. Open Telegram → Search `@BotFather`
2. Send `/newbot`
3. Name it: "VPN Order Manager"
4. Username: "your_vpn_bot" (must end with 'bot')
5. **Copy the token** (looks like: `123456789:ABC...`)

### 2. Get Your Chat ID (1 minute)
1. Search `@userinfobot` on Telegram
2. Send any message
3. **Copy your ID** (a number like: `123456789`)

### 3. Add to .env (30 seconds)
```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

### 4. Set Webhook (1 minute)
After deploying to Vercel:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://your-domain.vercel.app/api/v1/telegram/webhook"
```

### 5. Test! (30 seconds)
1. Place a test order on your website
2. Check Telegram for notification
3. Click "Approve" or "Reject"
4. Done! 🎉

## What You Get

### When Order is Placed:
```
🔔 New VPN Order

👤 Customer: John Doe
💳 KPay Ref: KP123456789
📦 Plan: 20GB
🕐 Time: 5/6/2026, 10:30 AM

[✅ Approve] [❌ Reject]
```

### After You Click Approve:
- ✅ Access key created automatically
- 🔑 Key sent to you in Telegram
- 📧 Customer notified
- 💾 Order marked as approved

### After You Click Reject:
- ❌ Order marked as rejected
- 📧 Customer notified
- 💾 Saved in history

## Benefits

- 📱 **Approve from anywhere** - Your phone, tablet, computer
- ⚡ **Instant notifications** - Know immediately when orders come in
- 🚀 **One-click approval** - No need to open admin panel
- 🔒 **Secure** - Only your chat ID can approve orders
- 🆓 **Free** - Telegram Bot API is completely free

## Need Help?

See full documentation: `TELEGRAM_SETUP.md`

## Optional

Don't want Telegram? Just don't add the environment variables. Everything works normally through the web admin panel.

---

**Ready in 5 minutes!** ⏱️
