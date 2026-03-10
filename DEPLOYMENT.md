# 🚀 AlgivixAI Deployment Guide
**Developed by EMEMZYVISUALS DIGITALS**

---

## 📋 Prerequisites

- Node.js v18+ installed
- A Groq API key (free at [console.groq.com](https://console.groq.com))
- A WhatsApp account to link the bot to

---

## ⚡ Quick Local Setup

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Configure environment variables
```bash
cp .env.example .env
```
Open `.env` and fill in your `GROQ_API_KEY`.

### Step 3 — Start the bot
```bash
npm start
```

### Step 4 — Scan QR Code
A QR code will appear in your terminal.
1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code
4. The bot will confirm: ✅ **AlgivixAI is now ONLINE**

### Step 5 — Find your Group JID
After the bot connects, it will log its JID. To find your group JID:
1. Add the bot's WhatsApp number to your group
2. Send any message in the group
3. Check the terminal — it will show the group's JID (e.g., `120363xxx@g.us`)
4. Copy that JID into your `.env` as `TARGET_GROUP_JID`

---

## ☁️ Cloud Deployment (24/7)

### Option A — Railway (Recommended) 🚂

**Best for:** Easy setup, free tier available, persistent storage for sessions.

1. Push your code to GitHub (without the `session/` folder)
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repository
4. In the Railway dashboard, go to **Variables** and add:
   ```
   GROQ_API_KEY = your_key_here
   TARGET_GROUP_JID = your_group_jid
   ADMIN_NUMBERS = your_number
   ```
5. Railway will auto-detect `package.json` and run `npm start`
6. **For QR scanning:** Go to the **Logs** tab to see the QR code output
7. Scan the QR code from your phone
8. Sessions are saved in `./session/` — Railway persists this between deploys

> ⚠️ **Important:** After QR scan, the `session/` folder contains auth credentials.
> Commit the session files to a **private repo only** or use Railway's persistent disk.

---

### Option B — Render 🟦

1. Push your code to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (or Starter for 24/7)
5. Add environment variables under **Environment**:
   ```
   GROQ_API_KEY = your_key
   TARGET_GROUP_JID = your_group_jid
   ADMIN_NUMBERS = your_number
   ```
6. Click **Deploy** → go to **Logs** and scan the QR code shown

> ⚠️ **Note:** Render's free tier spins down after 15 min of inactivity.
> Use a paid plan or use UptimeRobot to ping the service every 5 mins.

---

### Option C — VPS / DigitalOcean (Most Reliable) 🖥️

**Best for:** Full control, always-on, session persistence.

```bash
# SSH into your server
ssh user@your-server-ip

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your project
git clone https://github.com/yourusername/algivix-ai-bot.git
cd algivix-ai-bot

# Install dependencies
npm install

# Create .env file
cp .env.example .env
nano .env  # Fill in your values

# Install PM2 (process manager for 24/7 operation)
npm install -g pm2

# Start the bot with PM2
pm2 start index.js --name "algivix-bot"

# Auto-start on server reboot
pm2 startup
pm2 save
```

**Scan QR:**
```bash
pm2 logs algivix-bot
# QR code will appear in logs — scan it with WhatsApp
```

**Useful PM2 commands:**
```bash
pm2 status          # Check bot status
pm2 restart algivix-bot  # Restart bot
pm2 stop algivix-bot     # Stop bot
pm2 logs algivix-bot     # View live logs
```

---

### Option D — Replit (Easiest for Beginners) 🟢

1. Go to [replit.com](https://replit.com) → **Create Repl → Import from GitHub**
2. Import your repository
3. In the **Secrets** tab (🔒 icon), add:
   ```
   GROQ_API_KEY = your_key
   TARGET_GROUP_JID = 120363xxx@g.us
   ```
4. Click **Run**
5. Scan the QR code from the console

**Keep it alive 24/7:**
- Use [UptimeRobot](https://uptimerobot.com) to ping your Repl URL every 5 minutes
- Or upgrade to Replit Hacker plan for always-on repls

---

## 🔐 Session Management

The `session/` folder stores your WhatsApp authentication. 

**Rules:**
- ✅ Keep it backed up (it's your login)
- ✅ Add it to `.gitignore` to avoid exposing credentials
- ❌ Never share session files publicly
- 🔄 If you delete the session folder, you'll need to scan QR again

---

## 🔧 Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | ✅ Yes | Your Groq AI API key |
| `GROQ_MODEL` | No | AI model (default: `llama3-8b-8192`) |
| `TARGET_GROUP_JID` | No | WhatsApp group JID for scheduled messages |
| `ADMIN_NUMBERS` | No | Comma-separated admin phone numbers |
| `LOG_LEVEL` | No | Logging level (default: `info`) |

---

## 🤖 Bot Commands Reference

| Command | Description | Who |
|---------|-------------|-----|
| `!ai <question>` | Ask AI a development question | Anyone |
| `!review <code>` | Get AI code review & feedback | Anyone |
| `!task` | View current sprint tasks | Anyone |
| `!rules` | View group rules | Anyone |
| `!announce <msg>` | Post an official announcement | Admins only |
| `!help` | Show all commands | Anyone |
| `Who developed you?` | Show developer credit | Anyone |

---

## 📝 Customization Guide

### Update Tasks
Edit `tasks.json` to add, modify, or remove tasks. Changes take effect immediately.

### Update Rules
Edit `rules.json` to update group rules. Changes take effect immediately.

### Add New Commands
Open `commands.js`, add a new `case` in the `switch` block:
```javascript
case "!mycommand":
  return "Your response here";
```

### Change Scheduled Times
Open `index.js` and modify the `cron.schedule()` calls.
Cron format: `"minute hour day month weekday"`
- `"0 7 * * 1-5"` = 7:00 AM every weekday
- `"0 9 * * 1"` = 9:00 AM every Monday

---

## 🆘 Troubleshooting

**Bot not connecting?**
- Delete the `session/` folder and restart to get a new QR code

**AI not responding?**
- Verify your `GROQ_API_KEY` is set correctly
- Check your Groq API usage at console.groq.com

**Messages not being received in group?**
- Ensure the bot's WhatsApp number is in the group
- Verify `TARGET_GROUP_JID` is set correctly

**Bot responding to everything?**
- Check `moderation.js` filters aren't too aggressive

---

*Built with ❤️ by EMEMZYVISUALS DIGITALS for the Algivix Dev Team*
