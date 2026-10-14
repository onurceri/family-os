# Telegram

Telegram lets people ask the assistant and send things to Quick add from the app they already use, and get reminders and approval buttons back. It is optional. FamilyOS asks Telegram for new messages (long polling), so your server needs no public address.

## Create a bot (admin, once)

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot` and answer the questions. Pick a name, and a username that ends in `bot`.
3. Copy the token BotFather gives you.
4. In FamilyOS open **Settings → System → Telegram**, paste it into **Bot token** and press **Connect bot**.

The page shows **Connected as @yourbot** and its state; **Working** means it is polling. If something is wrong, the state says what: Telegram no longer accepts the token, it cannot be reached (FamilyOS keeps trying), or the token cannot be read because `FAMOS_SECRET` changed. The token is stored encrypted and is never shown again.

**Use another token** replaces it. A token for the same bot keeps everyone's links; a token for a different bot removes them, and everyone links again. **Disconnect bot** (then **Yes, disconnect**) removes the bot and every link.

Telegram only works while the FamilyOS worker is running (the default, see `FAMOS_ROLES`).

## Link your account (everyone)

Open **Settings → You → Notifications**, find **Telegram** and press **Link Telegram**. The section only appears once an admin has connected a bot. You get a code that works once for ten minutes. Press **Open in Telegram** and then **Start**, or send the bot `/start <your code>`. The bot answers that you are linked, and the app shows **Linked**.

Only linked people are heard. The bot ignores everyone else (a plain `/start` from a stranger only gets a hint to link first). Write to the bot in a private chat, not in a group.

## Ask the assistant

Write to the bot as you would to a person: "What is on the shopping list?", "Move the dentist to 4 pm". Typed text goes to the [assistant](assistant.md), and its answer comes back in the chat. Changes it suggests come with **✓** and **✗** buttons, and nothing changes until someone approves. The questions are kept in one conversation that you also see in the app's Assistant. One question at a time: while an answer is being written the bot says "still answering". If you may not use the assistant, or no AI model is set up, typed text goes to Quick add instead.

## What goes to Quick add

These land in Quick add, marked Telegram, as if you had shared them in the app:

- messages you **forward** from another chat (a school group, a message from the dentist);
- links on their own;
- photos (their location data is removed);
- documents: PDFs, text files, pictures and audio files, up to 20 MB;
- voice notes. They are turned into text when speech to text is set up; see [AI and privacy](ai.md);
- text after `/share`, for a note you type yourself: `/share Parent meeting on Thursday at 17:00`. Language packs give the command a name in their language too (in Turkish `/paylas`); `/start` shows the names.

Other kinds of files get the reply "I can only add photos, PDFs and text files." Video messages are not supported. The bot replies "Sent to Quick add." when it has taken something. The same rules apply as in the app: the daily upload limit counts, and if you are a supervised member, your suggestions wait for approval. When the AI has read what you sent and has suggestions, the bot sends you a message with the buttons below.

## Approve and reject from Telegram

When a suggestion is yours to decide, you get a Telegram message with a button pair per suggestion (up to 5). That is what you shared yourself, or a supervised member's suggestion waiting for an adult. You never get buttons for suggestions that belong to someone else, or that you may not approve. Each button pair is: **✓** with the suggestion's title, and **✗ Reject**. Pressing a button decides it as you; it is the same as deciding in Quick add. If someone else decided first, you are told it was already decided. When a suggested event is one you already have on another day, the message says so (**Already on the calendar: Regional Gala · Sat 7 Nov 18:00**) and adds a third button, **↪ Move it to Sat 14 Nov 09:00 instead**. It turns the suggestion into a change of that event, which then gets its own **✓** and **✗** buttons; nothing moves until you press **✓**. An **Open** button takes you to the app when FamilyOS has an `https` address; otherwise the address is written in the message.

Turn Telegram notifications off per kind under **Settings → You → Notifications**. Quiet hours apply to Telegram too.

## Unlinking

Press **Unlink Telegram** under **Settings → You → Notifications**, or send `/stop` to the bot.

## Privacy

Messages to the bot pass through Telegram's servers. They are **not end-to-end encrypted**. Share only what you would be comfortable sending that way. FamilyOS contacts Telegram only after an admin connects a bot.

## One bot, one FamilyOS

A bot token can be used by one running program at a time. If a second instance polls with the same token, Telegram answers 409 and **Settings → System → Telegram** says another instance is polling with this token. **Use a separate bot for testing and development**, never your family's bot.
