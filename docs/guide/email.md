# Email

School notices, invitations and bills reach Quick add without opening the app. Optional. FamilyOS reads **one dedicated mailbox** every few minutes and turns unread mail from allowed senders into Quick add items marked Email. Suggestions wait for approval like any shared item.

## Which mailbox

FamilyOS logs in over IMAP with a user name and an **app password**. Use a mailbox made for this, not a personal inbox:
- an address on your own domain, or at Fastmail, mailbox.org or similar;
- a mail server you run;
- Proton Mail through Proton Bridge: give FamilyOS Bridge's certificate authority with `NODE_EXTRA_CA_CERTS` (certificates are always checked).

**Gmail and Outlook.com cannot be connected directly** (IMAP only with Google or Microsoft OAuth, which FamilyOS does not use). [Forward](#forwarding-from-gmail-outlook-and-school-portals) instead.

## Connect the mailbox (admin, once)

1. Create the mailbox and an app password (or normal password if the provider has none).
2. Open **Settings → System → Email**.
3. Enter **IMAP server** (`imap.fastmail.com`), **Port** (`993`), **User name**, **Password**.
4. Keep **Mailbox to read** `INBOX` and **Move handled mail to** `FamilyOS` (created if missing).
5. Press **Save and test**.

**Good to know**
- A failed test says why: wrong user name or password, server not reachable, certificate refused, mailbox missing, folder not usable. Your input is saved, but reading stays off until a test works.
- Always encrypted: port 993 uses TLS; port 143 must upgrade with STARTTLS or is refused. No plain option.
- The password is stored encrypted and never shown; leave it empty on later saves to keep it.
- Needs the FamilyOS worker running (default, see `FAMOS_ROLES`).

## Allow senders

Mail from addresses not listed is ignored.

1. Under **Allowed senders** press **Add sender**.
2. Enter the **Email address**, choose **Goes to the Quick add of** a member, optionally a **Note (optional)**.
3. Press **Add sender** to save.

**Good to know**
- Items are added as that person: theirs alone, a supervised member's suggestions wait for approval, the daily upload limit counts. They are notified when suggestions are ready.
- Add the school's address (`office@school.example`) for a parent's Quick add; add each parent's address so they can forward.
- Unallowed mail stays untouched; the page counts it ("3 messages from unknown senders are waiting in the mailbox"). Adding the address gets it read at the next check.
- If an `Authentication-Results` header says SPF or DKIM **failed**, the message is refused (counted under "messages refused") and stays in the mailbox. No header: accepted if the sender is listed.

## Forwarding from Gmail, Outlook and school portals

| Method | Sender seen | Notes |
|---|---|---|
| Filter that forwards as is (Gmail: Settings → Filters and blocked addresses → forward to; confirm the address first) | The school | Often fails SPF and is refused; then use another method. |
| "Forward" button, or an Outlook forwarding rule | You | Allow your own address. Not "Forward as attachment": attachments hold the original and are not read. |
| School portal | Usually a no-reply address | Allow it, or send to a personal address and forward from there. |

## What is read, and what never is

Read and kept:
- Subject (as title) and **plain text**. HTML-only mail is converted on the server: tags dropped, line breaks and lists kept, links written out as text.
- Attachments that are really PDFs, pictures, audio or plain text: at most 6 per mail, 25 MB together. Pictures lose location data. File content is checked, so a fake `invoice.pdf` is skipped, as are layout pictures (logos, signatures).

Never:
- Loading any picture, link, font or script, so tracking pixels do nothing. HTML mail is never shown.
- Text people cannot see is removed (zero-width and direction-control characters; `display:none`, zero font size, white on white), a way to slip instructions to an AI.
- Other attachments (programs, archives, calendar and Office files) are ignored.
- Logging the password, addresses, subjects or text. Logs only count messages.

## Day to day

- A check runs every 5 minutes (**Check every (minutes)**, 2 or more); **Check now** runs one at once.
- Only unread mail: opening it in a mail app first skips it.
- At most 40 messages per check; larger than 40 MB is refused.
- Added mail moves to the **FamilyOS** folder. Refused and unknown-sender mail stays.
- A message is never added twice, even if redelivered or moved back.
- If a message cannot be added (daily upload limit, Quick add off), it stays, the page counts it and the next check retries. It never blocks others.
- **Status** shows whether it works, last check, mails added so far, connection problems.

## Turning it off

**Read this mailbox** off + **Save and test** pauses. **Forget this mailbox** (**Yes, forget it**) removes the connection and password; allowed senders stay.
