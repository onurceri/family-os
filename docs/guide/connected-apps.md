# Connected apps

A connected app is a program that works with your family's data by itself (Home Assistant, a script, a phone shortcut). Each has its own **key**, a **role** limiting what it may do, and a **mode**: its changes happen at once or wait for a person.

> Admins manage apps in **Settings → You → Connected apps**, under **Apps and scripts**; others see only their own [AI apps](mcp.md) there. See also [the API](api.md) and [Siri and Shortcuts](siri.md).

**Good to know**
- An app is never a person: whatever its role, it **cannot** manage people, roles, devices or keys, install extensions or turn on auto-approval, and **can never approve a suggestion**.
- A role in use by an app cannot be deleted until the app is revoked.

## Add an app

1. Press **Add an app** (needs a password sign-in; a PIN is not enough).
2. Fill in the panel:

| Field | What it does |
|---|---|
| **Name** | "Home Assistant" or "Hall script". Shown on the suggestions the app makes. |
| **Role** | What it may do; the roles of **Settings → Family → Roles**. **Guest** only looks, **Member** changes what a member can; use your own role to allow less. |
| **What happens to its changes** | **Changes apply**: at once, for programs you trust. **Changes wait for approval**: each becomes a suggestion a person approves, like the AI's; use it when an AI sits behind the app (Home Assistant's voice assistant). |
| **May act for** | People it may work as. Empty: only as itself. |
| **Key lasts** | Until revoked (default) or 30, 90, 180 or 365 days. |

3. Press **Add app**. The key appears **once**: copy it into the app (Home Assistant: your address and this key).

**Good to know**
- If the key could not be made, the app is added without one; its panel opens, use **Add a key**.
- Only a fingerprint is kept: a lost key cannot be looked up. Add a new one, revoke the old.

## Acting for a person

An app allowed to act for Leo sends `X-FamilyOS-On-Behalf-Of: <Leo's id>` (**Copy id** beside his name under **May act for**, or `actsFor` in the API's first call). It then works as Leo:

- Only what **both** Leo and the app's role may do. A supervised Leo stays supervised: changes wait for approval.
- His own things stay his (a chore done through the app counts as Leo's).
- Still no approving suggestions, making keys or changing settings, even if Leo is an admin.
- Suggestions read "Leo via Home Assistant"; from the app alone, "Suggested by Home Assistant".
- Naming someone the app may not act for, or who left the family, is refused. Without the header the app works as itself.

## Keys: rotate, revoke, pause

Open an app to see each key's last use and end; the page warns two weeks before a key ends.

- **Replace a key**: **Add a key**, put it in the app, **Revoke** the old one (both work meanwhile).
- **Pause** stops all its keys; **Resume** undoes it. **Revoke app** ends it for good.
- Role, mode and **May act for** changes apply from the next request.
- After a [backup restore](backups.md) every app is paused (a key may have leaked since). Resume the ones you trust.

## If a key leaks

Revoke the key (or app) at once. It can do no more than the app's role, never what only people do. For anything you do not control, use **Changes wait for approval** and a small role.
