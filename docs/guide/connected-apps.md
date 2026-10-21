# Connected apps

A connected app is a program that works with your family's data by itself: Home Assistant showing the calendar on a dashboard, a script that adds a task, a shortcut on a phone. Each one has a **key of its own**, a **role** that limits what it may do, and a **mode** that says whether its changes happen at once or wait for a person.

Only admins add and look after apps, in **Settings → You → Connected apps**, under **Apps and scripts**. Everyone else sees only their own [AI app keys](mcp.md) there.

An app is never a person. Whatever role you give it, an app **cannot** manage people, roles, devices or keys, cannot install extensions, cannot turn on auto-approval and **can never approve a suggestion**. Those stay with people who are present.

## Add an app

Press **Add an app** (you must be signed in with your password; a PIN is not enough, because the key works away from your home). A panel asks for:

- **Name**: "Home Assistant" or "Hall script". It is shown on the suggestions the app makes.
- **Role**: what the app may do. It is the same list as for people (**Settings → Family → Roles**). A **Guest** app can only look; a **Member** app can change what a member can; pick a role of your own to allow less. A role an app uses cannot be deleted until the app is revoked.
- **What happens to its changes**:
  - **Changes apply**: what its role allows happens at once. For programs you trust.
  - **Changes wait for approval**: every change becomes a suggestion that a person approves first, like the AI's. Choose this when an AI sits behind the app (for example Home Assistant's own voice assistant).
- **May act for**: the people the app may ask to work as. Leave it empty if the app only needs to work as itself.
- **Key lasts**: until revoked (the default, so the app does not stop one day without warning) or 30, 90, 180 or 365 days.

Press **Add app**. The key appears **once**: copy it into the app. If the key could not be made, the app is added without one: its panel opens, and **Add a key** makes it. FamilyOS keeps only a fingerprint, so a lost key cannot be looked up; add a new key and revoke the old one. For Home Assistant, give the FamilyOS integration your address and this key. To write a program of your own, see [the API](api.md). To talk to FamilyOS from an iPhone, see [Siri and Shortcuts](siri.md).

## Acting for a person

An app that is allowed to act for Leo can say so with the header `X-FamilyOS-On-Behalf-Of: <Leo's id>` on a request. Find the id with **Copy id** next to his name under **May act for** in the app's panel, or in the `actsFor` list of the API's first call. It then works as Leo:

- It can do only what **both** Leo and the app's role may do. A supervised Leo stays supervised: his changes wait for approval.
- His own things stay his, so a chore marked done through the app counts as Leo's.
- It still cannot approve suggestions, make keys or change settings, even if Leo is an admin.
- A suggestion shows as "Leo via Home Assistant". A suggestion from the app alone shows "Suggested by Home Assistant".

A request that names someone the app may not act for, or someone who has been removed from the family, is refused. Without the header the app works as itself, with its role alone.

## Keys: rotate, revoke, pause

Open an app to see its keys, when each was last used and when it ends. Two weeks before a key ends the page says so.

- **To replace a key**: press **Add a key**, put the new key in the app, then **Revoke** the old one. Both work in between, so nothing stops.
- **Pause** stops every key of the app at once and can be undone with **Resume**. **Revoke app** ends the app and all its keys for good.
- Changing the role, the mode or who it may act for applies from the next request.

After you [restore a backup](backups.md), every app is paused: a backup can hold a key that was leaked or replaced since. Look at them and resume the ones you trust.

## If a key leaks

Revoke the key (or the app) at once. A leaked key can do no more than the app's role allows, and never anything only people do. Prefer **Changes wait for approval** and a small role for anything you do not fully control.
