# HTTPS and phones

On your home network, `http://<server>:3000` works in any browser. To **install FamilyOS on phones** and use **Share → FamilyOS**, browsers require HTTPS.

1. Pick option A or B below.
2. Set `FAMOS_BASE_URL` to the address people will use and restart (`docker compose up -d`).
3. If people also reach FamilyOS by another address (for example the server's IP address at home), list it in `FAMOS_TRUSTED_ORIGINS`, separated by commas. FamilyOS checks where requests come from against these addresses.

## Option A: Tailscale (no open ports)

Install Tailscale on the server and on the family's phones, then on the server:

```bash
tailscale serve --bg 3000
```

Tailscale prints an address such as `https://homeserver.tail1234.ts.net`. Use it as `FAMOS_BASE_URL`. Only devices in your tailnet can reach it.

## Option B: Caddy with your own domain

Point a domain (for example `family.example.com`) at your server, open ports 80 and 443, and add Caddy to `docker-compose.yml`:

```yaml
services:
  famos:
    # ...as before, plus:
    environment:
      FAMOS_BASE_URL: https://family.example.com
      # Caddy connects from the compose network; believe its X-Forwarded-For header.
      FAMOS_TRUSTED_PROXIES: 172.16.0.0/12

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from family.example.com --to famos:3000
    volumes: [caddy-data:/data]
    restart: unless-stopped

volumes:
  caddy-data:
```

Caddy gets and renews the certificate by itself.

### Good to know

- Sign-in attempts are limited per address. Behind a proxy every request seems to come from the proxy, so list only your proxy (an IP address or a range, separated by commas) in `FAMOS_TRUSTED_PROXIES`.
- Without `FAMOS_TRUSTED_PROXIES`, FamilyOS ignores `X-Forwarded-For` entirely, so nobody can fake their address.

## On the phones

1. Open the address and sign in.
2. Use the browser's **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Install app).
3. FamilyOS now appears in the share sheet of browsers that support it (Chrome on Android does). Shared items open a short preview; tap **Add to Quick add** to send them.

Where it does not appear, paste or attach the item under **Add to Quick add** on the Quick add page.

For a shared tablet in the kitchen, see [Family members, roles and devices](members.md): an admin marks it once under **Settings → Family → Devices**, and from then on the family picks their profile there and enters their PIN.
