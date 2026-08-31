# 🚀 PromptVault Pro — Complete Deployment Guide

PromptVault Pro is ready for immediate deployment across local networks, cloud hosting providers, and Docker containers.

---

## 📱 1. Instant Mobile & Local Wi-Fi Access (Active Right Now!)

Your server is currently running and accessible across all devices on your local Wi-Fi / LAN network.

- **Local PC**: [http://127.0.0.1:8000](http://127.0.0.1:8000)
- **Mobile Phone / Any device on your Wi-Fi**: [http://192.168.100.2:8000](http://192.168.100.2:8000)
- **Direct APK Download on Mobile**: [http://192.168.100.2:8000/download/promptvault.apk](http://192.168.100.2:8000/download/promptvault.apk)

> 💡 **How to open on your phone**: Connect your phone to the same Wi-Fi, open Chrome or Safari, and navigate to `http://192.168.100.2:8000`.

---

## ☁️ 2. Method 1: Render.com (100% Free Cloud Web Hosting)

**Render** gives you free HTTPS cloud hosting with automatic SSL:

1. Create a free account at [https://render.com](https://render.com).
2. Push or upload this project folder (`prompt-vault`) to a GitHub repository.
3. On the Render Dashboard, click **New +** → **Web Service**.
4. Connect your GitHub repository.
5. Set the following settings:
   - **Name**: `promptvault-pro`
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt && python apk_builder.py`
   - **Start Command**: `python server.py`
   - **Plan**: `Free`
6. Click **Create Web Service**.
7. Render will automatically build the app and give you a free live HTTPS URL (e.g. `https://promptvault-pro.onrender.com`)!

---

## ⚡ 3. Method 2: Railway.app (Free & One-Click)

1. Go to [https://railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project** → **Deploy from GitHub Repo**.
3. Select your `prompt-vault` repository.
4. Railway will automatically detect the `Dockerfile` or `Procfile` and deploy your app.
5. Under service settings, click **Generate Domain** to get your public live URL.

---

## 🐳 4. Method 3: Docker / VPS Server (Ubuntu, Debian, AWS, DigitalOcean)

If you have a VPS or server with Docker installed:

```bash
# Clone or copy prompt-vault files into your server
cd prompt-vault

# Build and start container in background
docker compose up -d --build
```

Your app will be live at `http://your-server-ip:8000`.

---

## 🌐 5. Method 4: Cloudflare Tunnel (Free Public Domain from Home PC)

If you want a free, secure public internet domain pointing to your PC:

1. Download Cloudflare Tunnel (`cloudflared`) from [https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Run in terminal:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
3. Cloudflare will instantly output a public HTTPS URL (e.g., `https://random-subdomain.trycloudflare.com`) that anyone in the world can access!
