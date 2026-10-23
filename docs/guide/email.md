# Email

School notices, invitations and bills reach Quick add without anyone opening the app. Optional. FamilyOS reads **one dedicated mailbox** every few minutes and turns the unread mail of the people you allow into Quick add items marked Email. Quick add reads them like anything else you share: suggestions wait for someone to approve them.

## Which mailbox

FamilyOS logs in with an IMAP user name and an **app password**. Use a mailbox made only for this, not a personal inbox:
- an address on your own domain, or at Fastmail, mailbox.org or a similar provider;
- a mail server you run yourself;
- Proton Mail through Proton Bridge. Bridge uses a certificate it made itself, so give FamilyOS the Bridge certificate authority with the standard Node setting `NODE_EXTRA_CA_CERTS` (certificates are always checked).

**Gmail and Outlook.com accounts cannot be connected directly.** They only accept a Google or Microsoft sign-in (OAuth) for IMAP, which FamilyOS does not use. [Forward](#forwarding-from-gmail-outlook-and-school-portals) from them instead.

## Connect the mailbox (admin, once)

1. Create the mailbox and an app password for it (or its normal password if your provider has none).
2. Open **Settings → System → Email**.
3. Enter the **IMAP server** (for example `imap.fastmail.com`), the **Port** (`993`), the **User name** and the **Password**.
4. Leave **Mailbox to read** as `INBOX` and **Move handled mail to** as `FamilyOS` (created if it does not exist).
5. Press **Save and test**. FamilyOS logs in, opens the mailbox and creates the folder. If something is wrong the page says what: wrong user name or password, server not reachable, certificate refused, mailbox missing, folder not usable. What you typed is saved, but reading stays off until a test works.

**Good to know**
- The connection is always encrypted: port 993 uses TLS from the start, port 143 must upgrade with STARTTLS or the connection is refused. There is no plain option.
- The password is stored encrypted and never shown again; leave the field empty on later saves to keep it.
- Email only works while the FamilyOS worker runs (the default, see `FAMOS_ROLES`).

## Allow senders

Mail from addresses not on the list is ignored.

1. Under **Allowed senders** press **Add sender**.
2. Enter the **Email address**, choose **Goes to the Quick add of** a family member, optionally add a **Note (optional)**.
3. Press **Add sender** again to save.

**Good to know**
- The item is added as that person, so the app's rules apply: it is theirs alone, a supervised member's suggestions wait for approval, and the daily upload limit counts. That person gets a notification when mail has been read and has suggestions.
- Add the school's address (`office@school.example`) to put its mail in a parent's Quick add. Add each parent's own address to let them forward mail to the family mailbox.
- Mail from an unallowed address stays untouched in the mailbox. The page counts it ("3 messages from unknown senders are waiting in the mailbox"). Once you add that address, the waiting mail is looked at again at the next check.
- Anyone can write any address in the From line. If your provider adds an `Authentication-Results` header (most do) saying SPF or DKIM **failed**, FamilyOS refuses the message and counts it under "messages refused". It stays in the mailbox. Mail without such a header is accepted when the sender is on your list.

## Forwarding from Gmail, Outlook and school portals

The sender FamilyOS sees depends on how you forward:

| Method | Sender seen | Notes |
|---|---|---|
| A filter that forwards as it is (Gmail: Settings → Filters and blocked addresses → forward to; confirm the forwarding address first) | The school | The forwarding server often fails SPF at the family mailbox, so the mail is refused. If mail is counted as refused, use another method. |
| The normal "Forward" button, or an Outlook rule that forwards | You | Add your own address as an allowed sender. Never use "Forward as attachment": the original is inside an attachment that is not read. |
| School portal | Usually a no-reply address | Add that address as a sender, or have the portal send to a personal address of yours and forward from there. |

Forwarded text is read from the message body. Attachments are kept.

## What is read, and what never is

Read and kept:
- The subject (as the title) and the **plain text**. A message with only HTML is converted to text on the server: tags are dropped, line breaks and lists are kept, links are written out as text next to what they say.
- Attachments that really are PDFs, pictures, audio or plain text files, at most 6 per mail and 25 MB together (Quick add's limits). Pictures lose their location data. FamilyOS checks the first bytes of each file, so a `invoice.pdf` that is not a PDF is skipped. Pictures that are part of the layout (logos, signatures) are skipped too.

Never done:
- No picture, link, font or script in a mail is loaded, so tracking pixels do nothing and the sender cannot tell you read it. HTML mail is never shown.
- Text a person cannot see is removed: zero-width and direction-control characters, and hidden HTML (`display:none`, zero font size, white on white). That is a common way to slip instructions to an AI.
- Other attachments (programs, archives, calendar files, Office files) are ignored.
- The mailbox password, addresses, subjects and mail text are **not written to the logs**. The logs only say how many messages were looked at.

## Day to day

- A check runs every 5 minutes; change it under **Check every (minutes)** (2 or more). **Check now** asks the worker to look immediately.
- Only unread mail is looked at: a message you open in a mail app first is not picked up.
- At most 40 messages are handled per check; the rest wait. A message larger than 40 MB is refused.
- A mail from an allowed sender becomes a Quick add item, then moves to the **FamilyOS** folder, your own record of what was taken. Refused mail and mail from unknown senders stays where it is.
- The same message is never added twice, even if the server delivers it again or you move it back.
- A message that cannot be added (daily upload limit reached, Quick add off) stays where it is; the page says how many and the next check retries. One failing message never blocks the others.
- **Status** shows whether it works, the last check, how many mails were added so far, and any connection problem.

## Turning it off

Switch **Read this mailbox** off and press **Save and test** to pause. **Forget this mailbox** (then **Yes, forget it**) removes the saved connection and password; the allowed senders stay.
