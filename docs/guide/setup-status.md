# Setup status

Some things only work once they are set up, and FamilyOS cannot always tell you when they are not: on a plain `http` address a phone cannot install the app, notifications and sharing do not work; with no AI provider Quick add cannot read what you share; with no off-site backup a broken or lost device takes everything with it.

**Settings → System → Setup status** (admins) lists these checks, each as a row that says what it is, whether it is **Done** or **Missing**, and, while it is missing, what stops working. A missing row has a button that goes to the page where you put it right. The page only reads; nothing on it changes by itself. When you are a new family, Today's first steps card links to it too.

| Check | Done when | While missing |
|---|---|---|
| Secure address | `FAMOS_BASE_URL` starts with `https://`, and you opened this page through a secure connection | Phones cannot install FamilyOS or get its notifications, sharing to FamilyOS and voice notes do not work, and AI apps cannot sign in from outside. The button opens the [HTTPS guide](https.md) |
| AI provider | A provider with a model is chosen under [Settings → AI](ai.md) | Quick add cannot read, the assistant cannot answer, search by meaning is off |
| Off-site backup | At least one backup copy is switched on under [Backups](backups.md) | If this device is lost, so is everything on it |
| A trusted device for PINs | At least one family device is trusted. Shown only when someone has a PIN | No one can sign in with a PIN |
| Notifications on phones | At least one person has a phone or a [Telegram](telegram.md) account linked. Shown only with a secure address | Reminders reach no one's phone |

Extensions add their own rows, the same ones Today's first steps show (for example choosing a place for the weather). A row's button appears only if your role may open the page it goes to.
