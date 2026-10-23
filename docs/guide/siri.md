# Siri and Shortcuts

Say "Hey Siri, add to FamilyOS" and the shopping list grows. Apple's Shortcuts (iPhone, iPad, Mac, Apple Watch) talks to FamilyOS through [the API](api.md) with a [connected app](connected-apps.md) key. Three shortcuts follow.

## Before you start

1. As an admin: **Settings → You → Connected apps → Add an app**. Name "Siri", role **Member** (or your own, with less), **Changes apply**, **May act for** yourself. Press **Add app**, copy the key (shown once).
2. Your member id: open the app, press **Copy id** beside your name under **May act for**. Or `curl -H "Authorization: Bearer KEY" ADDRESS/api/public/v1/` lists `actsFor` with each `memberId` (starts with `member_`).
3. The phone must reach your FamilyOS address wherever you speak: home network, or anywhere via Tailscale or https ([HTTPS and phones](https.md)).

`ADDRESS` is your FamilyOS address, `KEY` the key, `MEMBER` your member id.

## Shortcut 1: Add to shopping

In **Shortcuts** press **+** and name it **Add to FamilyOS** (what you say to Siri). Actions, in order:

1. **Ask for Input**: type Text, prompt "What do you need?" (spoken, it listens).
2. **Replace Text**: find ` and `, replace with `,`, in **Provided Input**.
3. **Split Text**: **Replaced Text** by **Custom**, separator `,`. "milk and eggs, bread" becomes milk, eggs, bread. FamilyOS removes spaces around the pieces.
4. **Repeat with Each** over **Split Text**. Inside it, **Get Contents of URL** with URL `ADDRESS/api/public/v1/lists/shopping/items`. Press **Show More** and set:
   - **Method**: POST
   - **Headers**: `Authorization` = `Bearer KEY`; `X-FamilyOS-On-Behalf-Of` = `MEMBER`
   - **Request Body**: JSON. Add a field `items` of type **Array**, and in it one **Dictionary** with the field `title` (Text) set to **Repeat Item**.

   The JSON body sets `Content-Type: application/json`. Each piece is its own request, landing on the default shopping list.
5. Check the answer, inside the repeat, after **Get Contents of URL**:
   1. **Get Dictionary Value**: `error` from **Contents of URL**, then `message` from that. An error answer always has an `error`; a good one never does.
   2. **If** the message **has any value**: **Speak Text** "FamilyOS did not answer: " and the message, then **Stop This Shortcut**.
   3. **Otherwise**: **Get Dictionary Value** `status` from **Contents of URL**. If it is `drafted`, **Speak Text** "Waiting for approval" (see [Safety](#safety)); if not, **Speak Text** "Added to the shopping list".

If the phone cannot reach FamilyOS, Shortcuts stops with its own error (also "did not answer").

## Shortcut 2: What is on today

Name it **What is on today**.

1. **Current Date**.
2. **Format Date**: **Current Date**, format **Custom**, `yyyy-MM-dd`. Call it `Today`.
3. **Get Contents of URL**: `ADDRESS/api/public/v1/calendar/occurrences?from=Today&to=Today` (insert the `Today` variable in both places), method GET, header `Authorization` = `Bearer KEY`.
4. **Get Dictionary Value**: `error` from the contents, then `message`. **If** the message **has any value**: **Speak Text** "FamilyOS did not answer: " and the message, then **Stop This Shortcut**. Without this check an error would be read as an empty day.
5. **Get Dictionary Value**: `items` from the contents.
6. **Repeat with Each** over the items. Inside:
   1. **Get Dictionary Value** `title`, then `start`.
   2. **If** `allDay` is **yes**: **Text** "all day, Title". **Otherwise**: **Format Date** the `start` with **Custom** `HH:mm`, then **Text** "Time Title".
   3. **Add to Variable** `Lines` with that text.
7. After the repeat: **If** `Lines` has no value, **Speak Text** "Nothing today"; otherwise **Speak Text** with `Lines`. "Nothing today" is only said after a `200` answer with no events.

Events come in day order. `start` has the family's time zone; keep the phone in that zone or hours will be off.

## Shortcut 3 (optional): Add a task

Name it **Add a task**. **Ask for Input**, then **Get Contents of URL**: `ADDRESS/api/public/v1/lists/tasks`, POST, the same two headers, JSON body `title` (Text) = the answer. Check as in Shortcut 1: `error` `message` → speak "FamilyOS did not answer" and the message; `status` `drafted` → "Waiting for approval"; else "Task added".

## Safety

- The key does only what the app's role allows. A **Member** key can add to lists and calendar, never manage people, keys or settings, or approve a suggestion.
- The key is inside the shortcut: sharing the shortcut shares the key. Use a separate app per person or phone.
- Lost phone: **Settings → You → Connected apps** → **Revoke** the key (or **Pause** the app); the shortcut stops at once. A paused app answers "This app is paused in FamilyOS" (spoken); **Resume** restores the same key.
- With **Changes wait for approval**, or a supervised person, a spoken item becomes a suggestion a person approves; the answer says `drafted`.

## Other languages

Siri listens in the phone's language; FamilyOS stores words as spoken ("süt ve yumurta" gives "süt", "yumurta"). In step 2 of Shortcut 1 replace your language's "and" (` ve `) instead of ` and `, or add a second **Replace Text**.
