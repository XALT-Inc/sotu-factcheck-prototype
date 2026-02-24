# Deploy to AWS EC2 with HTTPS

Production deployment runbook for `factcheck.xaltexperiences.com`.

## Architecture

```
Internet → Caddy (ports 80/443, auto-TLS) → sotu-factcheck (port 8787, internal only)
```

Caddy handles Let's Encrypt certificate provisioning and renewal automatically.

## 1. Launch EC2 Instance

- **AMI:** Amazon Linux 2023
- **Instance type:** t3.small (2 vCPU, 2 GB RAM)
- **Storage:** 20 GB gp3
- **Security group inbound rules:**
  - SSH (22) — your IP only
  - HTTP (80) — 0.0.0.0/0 (Caddy redirects to HTTPS)
  - HTTPS (443) — 0.0.0.0/0

## 2. Allocate Elastic IP

Allocate an Elastic IP and associate it with the instance so the public IP survives reboots.

## 3. Configure DNS

Create an A record:

```
factcheck.xaltexperiences.com → <Elastic IP>
```

Wait for propagation (`dig factcheck.xaltexperiences.com` should return the IP).

## 4. Install Docker & Compose

SSH into the instance:

```bash
ssh -i your-key.pem ec2-user@<Elastic IP>
```

Install Docker:

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
```

Install Docker Compose plugin:

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

Log out and back in for group membership to take effect:

```bash
exit
ssh -i your-key.pem ec2-user@<Elastic IP>
docker --version && docker compose version   # verify both work
```

## 5. Clone & Configure

```bash
git clone https://github.com/your-org/sotu-factcheck-prototype.git
cd sotu-factcheck-prototype
cp .env.example .env
```

Edit `.env` — set at minimum:

```env
GEMINI_API_KEY=your-key-here
CONTROL_PASSWORD=your-shared-password
DOMAIN=factcheck.xaltexperiences.com
```

## 6. Build & Start

```bash
docker compose up --build -d
```

Watch logs until healthy:

```bash
docker compose logs -f
```

You should see Caddy obtain the TLS certificate automatically on first request.

## 7. Verify

```bash
# Health check
curl -s https://factcheck.xaltexperiences.com/health

# SSE stream (Ctrl+C to stop)
curl -N -H "x-control-password: YOUR_PASSWORD" https://factcheck.xaltexperiences.com/events

# Browser
# https://factcheck.xaltexperiences.com/ → login with shared password → dashboard
```

## Updating

```bash
cd sotu-factcheck-prototype
git pull
docker compose up --build -d
```

Caddy preserves TLS certs across restarts via named Docker volumes.

## Troubleshooting

**Caddy can't get TLS cert:** Ensure port 80 is open in the security group (Let's Encrypt uses HTTP-01 challenge) and DNS resolves correctly.

**SSE connections drop:** Verify the Caddyfile has `flush_interval -1` and all timeouts set to `0`.

**Container won't start:** Check `docker compose logs sotu-factcheck` for app errors. Ensure `.env` has valid `GEMINI_API_KEY`.

## Cost Estimate

| Resource | Monthly |
|----------|---------|
| t3.small | ~$15 |
| Elastic IP (attached) | $0 |
| 20 GB gp3 | ~$2 |
| **Total** | **~$17/mo** |
