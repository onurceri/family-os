# Bring your own agent (MCP)

If you already use a personal AI agent, such as Hermes Agent by Nous Research, Claude Desktop, Claude Code or another app that supports the **Model Context Protocol (MCP)**, you can connect it to FamilyOS instead of using the built-in [assistant](assistant.md). Then you can ask your agent "what is on the calendar this week?" or "put milk on the shopping list" from wherever you already talk to it.

**It has exactly the powers of the [assistant](assistant.md), and no more.** The agent sees only what you may see, and only in the areas the family has opened to the AI. Every change it proposes is a *suggestion* that you approve in FamilyOS, like everything else the AI does. It cannot send anything outside, and it cannot do what you cannot do.

**Its memory stays with the agent.** FamilyOS does not store what your agent remembers about you. Notes kept by the built-in assistant are never given to an outside agent.

FamilyOS does not talk to other agents on its own (the "agent-to-agent" kind of protocol is not supported): your agent connects to FamilyOS, not the other way round.

## Turn it on

AI apps cannot connect until an admin allows it: **Settings → You → Connected apps**, then **Allow AI apps to connect** (under **For the whole family**). FamilyOS asks you to confirm first, and after you turn it on or off a notice offers **Undo**. The assistant's page links here too (**Use your own AI agent**), and so does **Settings → AI → Usage & limits**. While it is off, no app key works.

Who may create app keys is a permission, **Connect AI apps with their own app key**. Admins and members have it by default; supervised members and guests do not. An app key lets an app the family did not choose read everything its holder can see and send it to that app's own AI provider, which the family's AI settings do not cover, so children do not get it unless an admin decides so. Change it per role in **Settings → Family → Roles**; a key someone already made stops working as soon as their role no longer has the permission. Keys can only be made after signing in with your password: someone who signed in with a PIN on a shared family device sees a note instead of the button. A key also stops when its owner signs out everywhere, gets a new password or is archived.

## Connect an app

Each app gets its own **app key**: like a password only for that app, which you can take back at any time. On **Settings → You → Connected apps**, press **Connect an app**. A panel walks you through three steps. (While AI apps are not allowed yet, only admins see this button; everyone else sees a note that an admin has to turn it on.)

1. **Turn on AI apps.** For the whole family, once; an admin presses **Turn on**. When it is on already, this step is done and says **On for the whole family**.
2. **Create a key for the app.** Give it a **Name** that says where it will be used ("Claude Desktop on my laptop"), choose **What it may do** (**Read only**, or **Read and suggest changes**; suggestions always wait for a family member to approve them) and, under **Valid for**, 30, 90, 180 or 365 days (90 by default). When it runs out it simply stops working; create a new one. Press **Create app key**.
3. **Copy the settings into the app.** The app key is shown here **once**; FamilyOS keeps only a fingerprint of it, so a lost key cannot be looked up: create a new one and revoke the old one. Under **Which app?** pick the app and press **Copy** on the block shown; it already carries the address and the key:
   - **Claude Desktop:** in Claude Desktop open Settings, Developer, **Edit config**, add the block and restart Claude. Claude Desktop reaches FamilyOS through a small helper (`npx mcp-remote`), so that computer needs [Node.js](https://nodejs.org).
   - **Claude Code:** one command to run once in a terminal (`claude mcp add --transport http familyos …`).
   - **Other apps:** a block to add where the app lists its MCP servers (see [the settings by hand](#for-developers-the-settings-by-hand) below). Some apps ask for the address and the header one by one.

   Then press **I have copied it**.

Your keys are listed under **My app keys**, with what each may do, until when it is valid and when it was last used. Each person can have up to 20 working app keys. Press **Revoke**, then **Revoke now**, and a key stops working at once. Admins can also see and revoke other people's keys, under **Other people's app keys**. Keys end by themselves when you are archived. A key starts with `famos_`, so it is easy to recognise if it ends up somewhere it should not.

Treat it like a password. It shows whoever holds it what you could see, in the areas open to the AI.

## For developers: the settings by hand

The app key is a bearer **token**; developers and most apps' documentation call it that. **For developers** at the foot of the Connected apps page shows the same. You need your agent's setting for an **MCP server over HTTP with a custom header**:

- **Address:** `https://<your FamilyOS address>/mcp` (the page shows yours)
- **Header:** `Authorization: Bearer famos_…`

A typical configuration looks like this (the exact keys differ per app; this is the **Other apps** block):

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

Claude Desktop starts only local servers from its config, so its block runs `mcp-remote` as a bridge and passes the header from an environment variable:

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

### Hermes Agent

Hermes Agent reads its MCP servers from the `mcp_servers` section of its config file (`~/.hermes/config.yaml`). A remote server takes a `url` and `headers`:

```yaml
mcp_servers:
  familyos:
    url: "https://<your FamilyOS address>/mcp"
    headers:
      Authorization: "Bearer famos_…"
```

The exact keys can change between versions: check the [Hermes Agent MCP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) for the version you run.

Use HTTPS when the agent is not on your home network (see [HTTPS and phones](https.md)).

### An agent that runs in the cloud

An agent hosted by its maker (for example Hermes Agent on Nous Research's cloud) is not on your home network, so it cannot reach FamilyOS until you open a route in. Open only the agent's door: `/mcp` needs nothing else from FamilyOS, so the rest of the app can stay private.

With a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) there is no port to open on your router, and the tunnel can be limited to that one path. In the `cloudflared` configuration:

```yaml
ingress:
  - hostname: familyos-mcp.example.com
    path: ^/mcp
    service: http://localhost:3000
  - service: http_status:404   # everything else stays closed
```

Then use `https://familyos-mcp.example.com/mcp` as the agent's address. Tailscale Funnel also works, but it publishes the whole port, not one path.

Once `/mcp` is on the internet, the app key is the only key, so:

- start with a **Read only** app key and a short **Valid for**;
- revoke an app key the moment you no longer trust where it is kept;
- watch **See what the AI did** for calls you did not expect. Repeated wrong keys are slowed down (`429`).

A hosted agent may keep its MCP settings somewhere other than a config file you edit (a settings screen, or a file inside its instance); look for "MCP servers" in its own settings.

**Which apps work.** Apps that accept a custom bearer header work. Apps that can *only* sign in through OAuth (a "Sign in with…" window) cannot connect yet: FamilyOS uses personal tokens, as Home Assistant does, and does not implement the OAuth flow. Tokens in the address (`?token=…`) are refused on purpose, because addresses end up in logs and history.

## What the app can do

- **Read tools**: the calendar, open tasks, the shopping list, what is due, the records of vehicles, pets and the home, and [Search](search.md) when it is set up.
- **Today**: the date, the weekday, the time, this week's first and last day and the weekday of each day from a week ago to two weeks ahead, in the family's time zone, so an agent never has to guess what "tomorrow" is or which day 20 October falls on. The instructions an agent gets when it connects say the date at that moment and tell it to ask for today again, because a connection can stay open past midnight.
- **Suggest tools** (app keys that may suggest): add an event, a task, shopping items and so on. Each creates a suggestion that waits in Quick add under **Waiting for you**, in a group **From a connected app**, where you approve or reject it; it is counted on Quick add in the side bar like every suggestion.
- **Its suggestions**: what became of the suggestions made through this app key (waiting, approved, turned down, taken back) and who decided each, by name ("approved by Sofia"). Suggestions made elsewhere (in Quick add, in the assistant or through another app key) are not listed, so the app never reports them as its own.
- Areas you switched **off** for the AI are not available. Areas set to **local only** are not available either, because an agent on another computer would take the data out of the house. See [AI and privacy](ai.md).
- People: the app can ask who is in the family only if **Send names and descriptions** is on in Settings → AI.

Names are given to the app as short references such as `vehicle:3fa9c1b2d4`, never as internal ids. The same record keeps its reference for the same app key, and another key sees a different one.

## Limits and what is recorded

- Each app key may make 60 requests per minute.
- Every call appears in **Settings → AI → Usage & limits → AI activity** with the app key's name and the areas it touched. Only metadata is kept, never what was asked or answered.
- App keys, requests and results are never written to the log.

## If something goes wrong

| What you see | Why |
|---|---|
| 404 | AI apps are not allowed to connect yet (turn the switch on) |
| 401 | The app key is wrong, expired or revoked, or was sent in the address instead of the header |
| 403 | Your role may no longer connect AI apps |
| 429 | Too many requests, or too many wrong keys from your address: wait a minute |
