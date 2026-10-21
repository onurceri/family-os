# Siri and Shortcuts

Say "Hey Siri, add to FamilyOS" and the shopping list grows. Apple's Shortcuts app can talk to FamilyOS through [the API](api.md), on an iPhone, iPad, Mac or Apple Watch. This page builds three small shortcuts. It needs no extra software, only a [connected app](connected-apps.md) with a key of its own.

## Before you start

1. As an admin, open **Settings → You → Connected apps** and press **Add an app**. Name it "Siri", choose the role **Member** (or a role of your own that may do less), choose **Changes apply**, and under **May act for** pick yourself. Press **Add app** and copy the key. It is shown once.
2. Find your member id. Open the app again from the list (press its name): under **May act for**, press **Copy id** beside your name and paste it somewhere you can reach. Or ask FamilyOS from a computer: `curl -H "Authorization: Bearer KEY" ADDRESS/api/public/v1/` lists `actsFor` with each person's `memberId`, which starts with `member_`.
3. The phone must reach your FamilyOS address wherever you say the words: at home on the same network, or from anywhere through Tailscale or https (see [HTTPS and phones](https.md)).

Below, `ADDRESS` is your FamilyOS address, `KEY` the key and `MEMBER` your member id.

## Shortcut 1: Add to shopping

Open **Shortcuts**, press **+** and name the shortcut **Add to FamilyOS**. That name is what you say to Siri. Add these actions in this order:

1. **Ask for Input**: type Text, prompt "What do you need?". (Spoken, it listens instead of asking you to type.)
2. **Replace Text**: find ` and `, replace with `,`, in **Provided Input** (the answer from step 1).
3. **Split Text**: **Replaced Text** by **Custom**, separator `,`. "milk and eggs, bread" becomes three pieces: milk, eggs, bread. Spaces around the pieces are removed by FamilyOS.
4. **Repeat with Each**: over **Split Text**. Inside it:
   1. **Get Contents of URL**, with URL `ADDRESS/api/public/v1/lists/shopping/items`. Press **Show More** and set:
      - **Method**: POST
      - **Headers**: `Authorization` = `Bearer KEY`; `X-FamilyOS-On-Behalf-Of` = `MEMBER`
      - **Request Body**: JSON. Add a field `items` of type **Array**, and in it one **Dictionary** with the field `title` (Text) set to **Repeat Item**.
5. After the repeat: **Speak Text** "Added to the shopping list".

`Content-Type: application/json` is set by choosing the JSON request body. Each piece is its own request; the items land on the family's default shopping list.

Check the answer instead of assuming it worked. Put these after **Get Contents of URL** (inside the repeat) and drop the final "Added to the shopping list" line:

1. **Get Dictionary Value**: `error` from **Contents of URL**, then **Get Dictionary Value** `message` from that. An error answer always has an `error`; a good one never does.
2. **If** the message **has any value**: **Speak Text** "FamilyOS did not answer: " followed by the message, then **Stop This Shortcut**.
3. **Otherwise**: **Get Dictionary Value** `status` from **Contents of URL**. If it is `drafted`, **Speak Text** "Waiting for approval" (see [Safety](#safety)); if not, **Speak Text** "Added to the shopping list".

If the phone cannot reach FamilyOS at all, the shortcut stops with Shortcuts' own error; that is also "did not answer".

## Shortcut 2: What is on today

Name it **What is on today**.

1. **Current Date**.
2. **Format Date**: **Current Date**, format **Custom**, `yyyy-MM-dd`. Call it `Today`.
3. **Get Contents of URL**: `ADDRESS/api/public/v1/calendar/occurrences?from=Today&to=Today` (insert the `Today` variable in both places), method GET, header `Authorization` = `Bearer KEY`.
4. **Get Dictionary Value**: `error` from the contents, then `message` from that. **If** the message **has any value**: **Speak Text** "FamilyOS did not answer: " and the message, then **Stop This Shortcut**. Without this check an error would be read as an empty day.
5. **Get Dictionary Value**: `items` from the contents.
6. **Repeat with Each** over the items. Inside:
   1. **Get Dictionary Value** `title`, then **Get Dictionary Value** `start`.
   2. **If** `allDay` is **yes**: **Text** "all day, Title". **Otherwise**: **Format Date** the `start` with **Custom** `HH:mm`, then **Text** "Time Title".
   3. **Add to Variable** `Lines` with that text.
7. After the repeat: **If** `Lines` has no value, **Speak Text** "Nothing today"; otherwise **Speak Text** with `Lines`. "Nothing today" is only said after a `200` answer with no events.

Events come in the order of the day. `start` carries the family's time zone; the phone shows it in its own, so keep the phone in the same zone as the family, or the hours will be off.

## Shortcut 3 (optional): Add a task

Name it **Add a task**. **Ask for Input**, then **Get Contents of URL** with `ADDRESS/api/public/v1/lists/tasks`, method POST, the same two headers, and a JSON body with the field `title` (Text) set to the answer. Then check the answer as in Shortcut 1: if the answer has an `error` `message`, speak "FamilyOS did not answer" and that message; if the `status` is `drafted`, speak "Waiting for approval"; otherwise speak "Task added".

## Safety

- The key does only what the app's role allows. A **Member** key can add to the lists and the calendar, but can never manage people, keys or settings, or approve a suggestion.
- The key is written inside the shortcut. Keep the shortcut on your own devices and do not share it: sharing a shortcut shares the key. Make a separate app for each person or each phone that needs one.
- If a phone is lost, open **Settings → You → Connected apps** and **Revoke** the key (or **Pause** the app). The shortcut stops working at once. A paused app answers "This app is paused in FamilyOS", which the shortcut speaks; **Resume** makes it work again with the same key.
- If you choose **Changes wait for approval**, or the person is supervised, a spoken item does not reach the list: it becomes a suggestion that a person approves, and the answer says `drafted`.

## Other languages

Siri listens in the language of the phone, and FamilyOS stores the words exactly as they were spoken. Say "süt ve yumurta" and the list shows "süt" and "yumurta". The word between items is yours to choose: in step 2 of Shortcut 1 replace ` ve ` (or whatever your language says for "and") instead of ` and `, or add a second **Replace Text**.
