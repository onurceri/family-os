# Bring your own agent (MCP)

Connect an AI agent you already use (Claude, ChatGPT, Claude Code, Hermes Agent, Home Assistant's AI, any **Model Context Protocol** app) and ask it "what is on the calendar this week?" or "put milk on the shopping list".

> For FamilyOS showing Home Assistant's sensors, see [Home Assistant](home-assistant.md). A script or a program that is not an AI agent is a [connected app](connected-apps.md).

**Good to know**
- It has the [assistant](assistant.md)'s powers and no more: it sees what you may see, in the areas open to the AI. Every change is a suggestion you approve. It cannot send anything outside.
- Its memory stays with the agent. Notes kept by the built-in assistant are never shared.
- Your agent connects to FamilyOS. FamilyOS never calls agents (no agent-to-agent protocol).

## Turn it on

An admin turns on **Settings → You → Connected apps → Allow AI apps to connect** (under **AI apps, for the whole family**). It asks to confirm, and offers **Undo**. The assistant (**Use your own AI agent**) and **Settings → AI → Usage & limits** link here. While it is off, no AI app works; [connected apps](connected-apps.md) are not affected.

There are two ways to connect:
- **[An app key](#connect-with-an-app-key)**: the app gets a key that works like a password. Any app that takes a header.
- **[Sign-in](#connect-by-signing-in)**: the app sends you to a FamilyOS page and you decide there. Claude, ChatGPT, Claude Code, Home Assistant.

## Connect with an app key

1. In **Connected apps**, press **Connect an AI app**. Only admins see it while AI apps are off.
2. Give it a **Name** ("Claude Desktop on my laptop"), choose **Read only** or **Read and suggest changes**, and **Valid for** (30, 90, 180 or 365 days; 90 by default). Press **Create app key**.
3. Under **Which app?**, pick the app and press **Copy**. The block holds the address and the key. The key is shown **once**.
   - **Claude Desktop:** Settings → Developer → **Edit config**, add the block, restart Claude. Needs [Node.js](https://nodejs.org) (`npx mcp-remote`).
   - **Claude Code:** run the command once in a terminal.
   - **Other apps:** add the block where the app lists MCP servers, or enter the address and header one by one ([by hand](#for-developers)).
4. Press **I have copied it**.

**Good to know**
- Creating keys needs the **Connect AI apps with their own app key** permission. Admins and members have it, supervised members and guests do not; change it in **Settings → Family → Roles**. A key stops when its owner's role loses it.
- Keys are made after a password sign-in. A PIN sign-in shows a note instead.
- A key stops when it expires, is revoked, or its owner signs out everywhere, changes password or is archived.
- **My AI apps** lists your keys and sign-ins (marked **Signed in**), with what each may do, until when, and when it was last used. **Revoke → Revoke now** ends one at once. Admins revoke others' under **Other people's AI apps**.
- Up to 20 working keys per person. A lost key cannot be shown again: make a new one and revoke the old.
- Keys start with `famos_`. Treat one like a password.

## Connect by signing in

An admin turns these on in **Connected apps**, under **AI apps, for the whole family**:

| Switch | Default | Notes |
|---|---|---|
| **Let AI apps sign in with a FamilyOS account** | off | Needs **Allow AI apps to connect**, and a family address (`FAMOS_BASE_URL`) with no path, like `https://family.example.com`. |
| **Let AI apps register themselves** | off | Only for apps that cannot sign in otherwise. You still decide on every sign-in. |
| **Allow on this home network without https** | off | For a plain `http` family address. Tokens then cross your network unencrypted. Turn it on **before** the sign-in switch. Works for Home Assistant. Claude Code and other apps built on the official MCP kit still need https, except on `localhost`. |

**Which apps work how**

| App | How |
|---|---|
| Claude, ChatGPT | Add `https://<your FamilyOS address>/mcp` as a connector. The address must be https and reachable from the internet. |
| Claude Code | The same address. https, or any address on the same computer (`localhost`). |
| Home Assistant | Set it up first as an app of its own ([below](#home-assistant)). Works over http with the switch above. |
| Apps that can only register themselves | Turn on **Let AI apps register themselves**. |
| Apps that take only a key | Use an [app key](#connect-with-an-app-key). |

### Claude, ChatGPT and Claude Code
- **Claude** (web, desktop, phone): **Settings → Connectors → Add custom connector**, name it, enter the address, **Add**. Sign in in the browser and press **Connect**.
- **ChatGPT**: **Settings → Apps**, turn on developer mode if your plan asks, **Create app**, enter the address, sign in the same way.
- **Claude Code**:
  1. `claude mcp add --transport http --scope user familyos https://<your FamilyOS address>/mcp`. `--scope user` works in every folder; without it, only in this folder; `--scope project` shares it in `.mcp.json`.
  2. Start `claude` (the first run in a folder asks to trust it).
  3. Run `/mcp`, choose **familyos**, authenticate. `claude -p` cannot sign in.

### Home Assistant
If your family address is `http`, turn on **Allow on this home network without https** first.

1. In **Connected apps**, press **Connect an AI app → Home Assistant (sign-in)**. Use Home Assistant's IP address (`http://192.168.1.20:8123`), not `homeassistant.local` ([why](home-assistant.md)); leave it empty for its cloud link. Press **Set up**. Copy the **client ID**, the **client secret** (shown once) and the address ending in `/mcp`.
2. In Home Assistant, **Settings → Devices & services**, add **Model Context Protocol** (not "… Server"). Enter the address ending in `/mcp`.
3. Enter a name, the client ID and the secret, and press **Add**. It returns to the address step.
4. Submit the address again, choose **Use existing credentials**, press **Open website**.
5. In FamilyOS, choose **Read only** or **Read and suggest changes**, and press **Connect**.
6. my.home-assistant.io asks once for your Home Assistant address (the IP) and to link the account. This step needs internet.
7. Keep the Home Assistant tab open until it shows **Success**. Closing it earlier makes no entry.

Only the person who set it up can connect it, and it acts as them. When a sign-in ends, Home Assistant shows a card: repeat from step 4. Connecting again ends the earlier connection; delete the older entry in Home Assistant. **AI apps you set up for sign-in** lists these apps; **Remove** also disconnects.

### The sign-in page
**Connect <app> to FamilyOS?** shows:
- who it works for: always you (**Not you? Sign out** switches account);
- where the sign-in returns, in bold;
- who the app is:
  - **Identified by its address** is read from the app's own site;
  - **This app registered itself** is shown in a warning colour, because no one can check it;
  - an app you set up shows the date it was set up;
- **Read only** or **Read and suggest changes**. You can give less than the app asked for, never more.

**Connect** lets it in; **Cancel** turns it away.

**Good to know**
- Signing in needs a password sign-in. A PIN shows **Sign in with your password to connect an AI app**. Displays and connected apps can never decide.
- Never decide on the name alone: an app names itself. A return address different from the app's own, or `localhost`, gets a warning. FamilyOS never loads an app's logo.
- A request ends after 10 minutes. An approval the app never completes is not listed and is cleared within a day.
- A connection ends after 90 days unused, on **Revoke**, when its sign-in is used twice, or on a restore from backup. You are told when one connects and when FamilyOS ends one.
- Connecting the same app again replaces the earlier connection.
- Self-registered apps that were never approved are forgotten after a day. At most 50 can wait, and one network address can register 10 an hour.
- Behind a reverse proxy, pass through `/mcp`, `/.well-known/` and `/oauth/`. An address with a path (`example.com/family`) cannot sign in.

## For developers

An app key is a bearer token. The settings for an **MCP server over HTTP with a custom header**:
- **Address:** `https://<your FamilyOS address>/mcp` (the page shows yours)
- **Header:** `Authorization: Bearer famos_…`. A token in the address (`?token=…`) is refused.

```json
{
  "mcpServers": {
    "familyos": {
      "url": "https://<your FamilyOS address>/mcp",
      "headers": { "Authorization": "Bearer famos_…" }
    }
  }
}
```

Claude Desktop only starts local servers, so it bridges through `mcp-remote`:

```json
{
  "mcpServers": {
    "familyos": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your FamilyOS address>/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer famos_…" }
    }
  }
}
```

**Hermes Agent** (`~/.hermes/config.yaml`; keys can change, see [its MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)):

```yaml
mcp_servers:
  familyos:
    url: "https://<your FamilyOS address>/mcp"
    headers:
      Authorization: "Bearer famos_…"
```

### An agent in the cloud
A hosted agent (Hermes on Nous Research's cloud, for example) needs a route in. Open only `/mcp`. With a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) no router port is opened:

```yaml
ingress:
  - hostname: familyos-mcp.example.com
    path: ^/mcp
    service: http://localhost:3000
  - service: http_status:404   # everything else stays closed
```

Tailscale Funnel works too, but it opens the whole port. Once `/mcp` is public, the key is the only lock:
- start with **Read only** and a short **Valid for**;
- revoke a key as soon as you stop trusting where it is kept;
- check **See what the AI did** for unexpected calls.

An agent outside your home network needs [HTTPS](https.md).

## What the app can do

- **Read**: calendar, open tasks, shopping list, what is due, vehicle, pet and home records, and [Search](search.md) when it is set up.
- **Today**: the date, time and weekday in the family's time zone. It also gets this week's first and last day, and the weekday of each day from a week ago to two weeks ahead. The agent is told to ask again, because a connection can stay open past midnight.
- **Suggest** (with "suggest" access): add events, tasks, shopping items and more. Each suggestion waits in Quick add under **Waiting for you**, grouped by app ("Claude", or "Ada via Claude"). The notice that one waits names the app.
- **Its suggestions**: what became of the ones made through this key (waiting, approved, turned down, taken back) and who decided. Suggestions from anywhere else are not listed.
- Areas set **off** or **local only** for the AI are unavailable ([AI and privacy](ai.md)).
- **People**: only when **Send names and descriptions** is on in **Settings → AI**.
- Records are named by short references (`vehicle:3fa9c1b2d4`), never internal ids. A reference stays the same for one key and differs between keys.

## Limits and records

- 60 requests per minute per key. Repeated wrong keys are slowed down.
- Every call appears in **Settings → AI → Usage & limits → AI activity**, with the key's name and the areas it touched. Only this metadata is kept, never questions or answers.
- Keys, requests and results are never logged.

## If something goes wrong

| What you see | Why |
|---|---|
| 404, or Claude Code's `ENDPOINT_NOT_FOUND … MCP endpoint not found` | AI apps are off, or (under `/.well-known/` or `/oauth/`) sign-in is off |
| 401 | Key wrong, expired, revoked, or sent in the address |
| 403 | Your role may no longer connect AI apps |
| 429 | Too many requests or wrong keys: wait a minute |
