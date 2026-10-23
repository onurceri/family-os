# Setup status

**Settings → System → Setup status** (admins) lists what must be set up for FamilyOS to work fully. Each row says what it is, whether it is **Done** or **Missing**, and, while missing, what stops working. A missing row has a button to the page where you put it right.

The page only reads; nothing changes by itself. Today's first steps card links to it for a new family.

| Check | Done when | While missing |
|---|---|---|
| Secure address | `FAMOS_BASE_URL` starts with `https://`, and you opened this page through a secure connection | Phones cannot install FamilyOS or get its notifications, sharing to FamilyOS and voice notes do not work, and AI apps cannot sign in from outside. The button opens the [HTTPS guide](https.md) |
| AI provider | A provider with a model is chosen under [Settings → AI](ai.md) | Quick add cannot read, the assistant cannot answer, search by meaning is off |
| Off-site backup | At least one backup copy is switched on under [Backups](backups.md) | If this device is lost, so is everything on it |
| A trusted device for PINs | At least one family device is trusted. Shown only when someone has a PIN | No one can sign in with a PIN |
| Notifications on phones | At least one person has a phone or a [Telegram](telegram.md) account linked. Shown only with a secure address | Reminders reach no one's phone |

### Good to know

- Extensions add their own rows, the same ones Today's first steps show (for example choosing a place for the weather).
- A row's button appears only if your role may open the page it goes to.
