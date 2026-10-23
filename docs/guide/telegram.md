# Telegram

Ask the assistant and send things to Quick add from Telegram, and get reminders and approval buttons back. Optional. FamilyOS polls Telegram, so the server needs no public address.

## Create a bot (admin, once)

1. In Telegram, open **@BotFather**.
2. Send `/newbot`; pick a name and a username ending in `bot`.
3. Copy the token.
4. In **Settings → System → Telegram**, paste it into **Bot token** and press **Connect bot**.

The page shows **Connected as @yourbot** and a state; **Working** means polling. Otherwise: Telegram rejects the token, it cannot be reached (FamilyOS keeps trying), or the token is unreadable because `FAMOS_SECRET` changed.

**Good to know**
- The token is stored encrypted, never shown again.
- **Use another token** replaces it. Same bot keeps links; a different bot removes them and everyone links again.
- **Disconnect bot** (**Yes, disconnect**) removes the bot and every link.
- Needs the FamilyOS worker running (default, see `FAMOS_ROLES`).
- One token, one running program: a second poller gets Telegram 409 and the page says another instance is polling. Use a separate bot for testing, never the family's.

## Link your account (everyone)

1. **Settings → You → Notifications → Telegram → Link Telegram** (shown once an admin connected a bot).
2. Press **Open in Telegram** then **Start**, or send `/start <your code>`. The code works once, for 10 minutes.
3. The bot confirms and the app shows **Linked**.

**Good to know**
- Only linked people are heard; a stranger's `/start` gets a hint to link first.
- Use a private chat, not a group.
- Unlink with **Unlink Telegram** there, or `/stop` to the bot.

## Ask the assistant

Write naturally: "What is on the shopping list?", "Move the dentist to 4 pm". Text goes to the [assistant](assistant.md); the answer comes back in the chat.
- Suggested changes come with **✓** and **✗**; nothing changes until approved.
- Questions share one conversation with the app's Assistant.
- One at a time: while answering, the bot says "still answering".
- Without assistant access or an AI model, typed text goes to Quick add.

## What goes to Quick add

Marked Telegram, as if shared in the app:

| You send | Notes |
|---|---|
| **Forwarded** messages | School group, dentist message. |
| Links on their own | |
| Photos | Location data removed. |
| Documents | PDFs, text, pictures, audio; up to 20 MB. |
| Voice notes | Become text if speech to text is set up ([AI and privacy](ai.md)). |
| `/share <text>` | A typed note: `/share Parent meeting on Thursday at 17:00`. Language packs add names (Turkish `/paylas`); `/start` lists them. |

**Good to know**
- Other files: "I can only add photos, PDFs and text files." No video.
- The bot replies "Sent to Quick add." when it took something.
- App rules apply: daily upload limit; supervised members' suggestions wait for approval.
- When the AI has suggestions, the bot sends buttons.

## Approve and reject from Telegram

For a suggestion you may decide (your own shares, or a supervised member's waiting for an adult) you get up to 5 button pairs: **✓** with its title and **✗ Reject**. Same as deciding in Quick add.

**Good to know**
- No buttons for others' suggestions or ones you may not approve.
- If someone decided first, you are told.
- A suggested event you already have on another day says **Already on the calendar: Regional Gala · Sat 7 Nov 18:00** and adds **↪ Move it to Sat 14 Nov 09:00 instead**; that makes a change of the event with its own **✓** and **✗**. Nothing moves until **✓**.
- **Open** goes to the app when FamilyOS has an `https` address; otherwise the address is in the message.
- Turn kinds off in **Settings → You → Notifications**. Quiet hours apply.

## Privacy

Messages pass through Telegram's servers, **not end-to-end encrypted**. FamilyOS contacts Telegram only after an admin connects a bot.
