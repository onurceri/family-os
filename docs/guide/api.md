# The API for apps and scripts

Programs (Home Assistant, a script, a phone shortcut) read and change your calendar, shopping lists, tasks, chores and board through an API. Each program is a [connected app](connected-apps.md): a key, a role, and a mode (changes apply, or wait for a person). It can do nothing a person with that role could not, and never what only people do (approve suggestions, manage people, keys or devices).

## Set up

1. As an admin: **Settings → You → Connected apps → Add an app**. Choose a name, role and mode; copy the key (shown once).
2. The API lives under `/api/public/v1`:

```bash
export FAMOS=https://family.example.com/api/public/v1
export KEY=famos_...            # the key you copied
curl -H "Authorization: Bearer $KEY" $FAMOS/
```

The key goes only in the `Authorization` header, never the address; a browser session does nothing here (the app's own `/api/v1` takes the session and refuses a key). Other web pages cannot call it from a browser.

`GET /` tells you what to expect:

```json
{
  "api": "v1",
  "familyOS": "0.2.1",
  "timeZone": "Europe/Istanbul",
  "language": "en",
  "caller": { "app": { "id": "app_…", "name": "Hall script", "mode": "apply" }, "memberId": null },
  "actsFor": [{ "memberId": "member_…", "name": "Leo" }],
  "extensions": [{ "id": "calendar", "version": "0.2.1", "enabled": true }, …],
  "operations": [
    { "name": "calendar.createEvent", "method": "post", "path": "/api/public/v1/calendar/events",
      "summary": "Add an event", "outcome": "apply" },
    …
  ]
}
```

- `actsFor`: people the app may act for (still in the family), each `memberId` for `X-FamilyOS-On-Behalf-Of`; empty if none.
- `operations`: only what **this** key may do now. `outcome` is `read`, `apply` or `draft` (waits for a person).
- An extension switched off in **Settings → Features** shows `"enabled": false`, loses its operations, and answers `404` `feature_off`.

Every operation is described in the OpenAPI document: `GET /openapi.json`, or `apps/server/public-openapi.json` in the source; generate client libraries from it.

## The rules every answer follows

- **Time.** One family time zone, carried as `timeZone` in every answer. A moment is RFC 3339 with offset (`2026-10-21T09:00:00+03:00`); a whole day is a plain date (`2026-10-21`). Send dates and times as the family writes them (`"date": "2026-10-21", "startTime": "09:00"`); answers give those and the moment (`start`, `end`).
- **Ids** look like `cal_event_0192…`, `task_…`, `shop_item_…`, `chore_…`, `board_note_…`, `member_…`. Use as is.
- **Lists** answer `{ "items": […], "next": null, "timeZone": … }`, at most 100 items a page (`?limit=` up to 500). Pass a non-null `next` back as `?cursor=` until it is `null`. A cursor belongs to the same question: do not reuse it with other parameters.
- **Changes** answer `{ "status": "applied", "result": …, "timeZone": … }`, or `202` `{ "status": "drafted", "draftId": … }` when they wait for a person.
- **Names.** The installation's shopping list has no name of its own; the API names it in the family's language with `"isDefault": true`.
- **Errors** are `{ "error": { "code": …, "message": … } }` ([below](#errors-and-limits)). Act on `code`; `message` is for people. A wrong request lists `"fields": [{ "path": "items[0].title", "message": "…" }]`.

## Reading

```bash
# Events between two days (inclusive), repeating events expanded; `to` may be at most 62 days
# after `from`, and a longer range is refused with `bad_request`
curl -H "Authorization: Bearer $KEY" "$FAMOS/calendar/occurrences?from=2026-10-20&to=2026-10-31"

# One event
curl -H "Authorization: Bearer $KEY" $FAMOS/calendar/events/cal_event_0192…

# The shopping lists, and one list's items
curl -H "Authorization: Bearer $KEY" $FAMOS/lists/shopping/lists
curl -H "Authorization: Bearer $KEY" $FAMOS/lists/shopping/lists/shop_list_0192…/items

# Tasks, chores (each has nextDue and overdue), the board
curl -H "Authorization: Bearer $KEY" $FAMOS/lists/tasks
curl -H "Authorization: Bearer $KEY" $FAMOS/chores
curl -H "Authorization: Bearer $KEY" $FAMOS/board/notes
```

An occurrence is one date of an event: `{ "eventId": …, "recurrenceId": "2026-10-28T16:00:00+03:00", … }`. `recurrenceId` is when that date was due and does not change if the date moves. A date moved out of a repeating event is an event of its own: `seriesId` names the series and `seriesRecurrenceId` when the series had it (instant, or day if all-day, like `recurrenceId`). Events and occurrences carry both.

**Ask only when something changed.** Every list has an `ETag`, which changes when what it shows, the day, the family's settings or the key's role changes. Send it as `If-None-Match`; an unchanged list answers `304` with no body:

```bash
curl -i -H "Authorization: Bearer $KEY" -H 'If-None-Match: "1a2b3c"' $FAMOS/lists/tasks
```

One thing (an event, a task) has the `ETag` of its version, such as `"v3"`.

## Changing

```bash
# Add an event
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Dentist","date":"2026-10-21","startTime":"09:00"}' $FAMOS/calendar/events

# Add shopping items to a list, or to the default list; tick one off and put it back
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"items":[{"title":"Milk","quantity":"2 l"}]}' $FAMOS/lists/shopping/lists/shop_list_0192…/items
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"items":[{"title":"Bread"}]}' $FAMOS/lists/shopping/items
curl -X POST -H "Authorization: Bearer $KEY" $FAMOS/lists/shopping/items/shop_item_0192…/complete
curl -X POST -H "Authorization: Bearer $KEY" $FAMOS/lists/shopping/items/shop_item_0192…/uncheck

# Add a task, finish it, change it
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Pay the school fee","dueDate":"2026-10-25"}' $FAMOS/lists/tasks
curl -X POST -H "Authorization: Bearer $KEY" $FAMOS/lists/tasks/task_0192…/complete
curl -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"notes":"Bring cash"}' $FAMOS/lists/tasks/task_0192…

# Mark a chore done: send the chore's `nextDue` as `dueDate`, the date it is done for
# (an app is nobody, so it says who did it)
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"dueDate":"2026-10-21","doneBy":"member_0192…"}' $FAMOS/chores/chore_0192…/complete

# Put a note on the board
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"Back at six"}' $FAMOS/board/notes

# Change a note (what you leave out stays; "endsOn": null lets it stay for good), or take it off
curl -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"Back at seven"}' $FAMOS/board/notes/board_note_0192…
curl -X DELETE -H "Authorization: Bearer $KEY" $FAMOS/board/notes/board_note_0192…
```

- A note can be changed or removed by whoever put it up and by anyone who manages the board. A note an app puts up on its own is the app's (the board shows the app's name; the API sets `createdByApp`); one put up for a member stays theirs.
- Verbs: `POST` adds or does something (`…/complete`, `…/reopen`, `…/uncheck`), `PATCH` changes the fields you send, `PUT` replaces the whole thing, `DELETE` removes it.
- One date of a repeating event: `DELETE …/calendar/events/{id}?occurrence=<recurrenceId>` (write `+` in an offset as `%2B`); without `occurrence` the whole series goes.

**Repeat a request safely.** Send `Idempotency-Key: <unique>` (letters, digits, `_`, `-`, up to 100). A repeat of the same request returns the first answer (header `Idempotent-Replayed: true`) and changes nothing twice; the same key with another request is `422`. Keys belong to the sending app and are kept a week.

**Change only what you saw.** Every thing has a `version` that rises with each write. Send it as `If-Match`; a change to something that moved on is refused with `412 precondition_failed` (`currentVersion` has the current one). `PUT` always needs `If-Match`; `PATCH`, `POST` commands and `DELETE` accept it; an operation that cannot compare answers `400`. Every change returns the new version in the `ETag` header.

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H 'If-Match: "v3"' -H 'Content-Type: application/json' \
  -d '{"event":{…every field…}}' $FAMOS/calendar/events/cal_event_0192…
```

## When a change waits for approval

An app in **Changes wait for approval** mode, or acting for a member who may only suggest (a child), changes nothing at once: the answer is `202` with a `draftId`, and a person approves it among the suggestions. The API can never approve one.

```bash
curl -H "Authorization: Bearer $KEY" $FAMOS/drafts/draft_0192…
```

`status` is `waiting`, `applied` (with the `result` the change would have answered), `rejected`, `undone`, `expired` or `failed`. A suggestion can be read by id only by the app (and the member) that made it.

**The suggestions that wait.** A program that shows what waits for a decision lists them:

```bash
curl -H "Authorization: Bearer $KEY" "$FAMOS/drafts?status=waiting"
```

```json
{
  "items": [
    { "id": "draft_0192…", "status": "waiting", "extension": "calendar",
      "title": "Add an event", "subject": "Dentist",
      "proposedAt": "2026-10-20T19:04:29+03:00", "proposedBy": "Leo via Hall script",
      "canDecide": false }
  ],
  "next": null,
  "timeZone": "Europe/Istanbul"
}
```

- It is Quick add's list as far as this key may see. An app alone sees what it made as itself, and what it made for a member when acting for them. Acting for a member (`X-FamilyOS-On-Behalf-Of`) it sees what that member sees (their own and those they may decide), never more than its role allows.
- Suggestions whose day passed or whose subject is gone are not listed.
- `status`: `waiting`, or `failed` (approved, could not be made, will be retried).
- `title` is the suggestion, `subject` what it is about (when known), `proposedBy` a person, an app or `Leo via Hall script` (null if nobody). All in the family's language.
- `canDecide` is always `false`: people decide in FamilyOS.
- Pages like other lists, newest first, with an `ETag`.

## What changed since I looked

For a program with its own copy, poll `GET /changes` instead of rereading everything:

```bash
curl -H "Authorization: Bearer $KEY" $FAMOS/changes                 # {"changes":[],"cursor":812,…}: where "now" is
# read everything you need, then later:
curl -H "Authorization: Bearer $KEY" "$FAMOS/changes?since=812"
```

It lists each thing changed since the cursor once: `{ "extension": "calendar", "entity": "event", "id": "cal_event_…", "op": "upsert" }`. `upsert`: read it again; `delete`: gone for you.

- A changed or removed `subscription` (subscribed calendar): reread the occurrences.
- Expired or failed suggestions show as `draft`.
- Ignore kinds you do not know.
- Send the new `cursor` next time; if `more` is true, ask again at once.
- Only what this key may see.
- Kept 30 days; an older cursor answers `410 gone`: reread everything.

## Acting for a member

Add `X-FamilyOS-On-Behalf-Of: <Leo's id>` and the request is Leo's: only what both Leo and the app's role allow, his things stay his, suggestions say "Leo via Hall script". Someone the app may not act for is refused (`403`, `reason: on_behalf`).

## Errors and limits

| Code | Status | What it means, and what to do |
|---|---|---|
| `bad_request` | 400 | The request is wrong; `fields` names which, each with a `path` and a `message`. Fix it; do not repeat it unchanged. |
| `unauthenticated` | 401 | No valid key: missing, wrong, revoked or expired. Do not retry; ask a person for a new key. With `reason: "paused"` the key is right but its app is paused in **Connected apps**: it works again after **Resume**, so retry later (slowly) and do not ask for a new key. |
| `forbidden` | 403 | The key's role, or the member it acts for, may not do this. `reason` says why: `capability` (the role lacks `capability`), `approval`, `critical`, `on_behalf` (the app may not act for that member). Do not retry. |
| `not_found` | 404 | There is no such thing, or it is not yours to know of. |
| `feature_off` | 404 | The extension was switched off in **Settings → Features**. Its operations are gone from `GET /` until it is switched on again. |
| `conflict` | 409 | The thing is not in a state that allows this. Read it again, then decide. |
| `gone` | 410 | The changes since that cursor are no longer kept. Read everything again, then start from a new cursor. |
| `precondition_failed` | 412 | It changed since the `version` you sent as `If-Match`; `currentVersion` is the version now. Read it again and redo your change on it. |
| `idempotency_mismatch` | 422 | The `Idempotency-Key` was already used for another request. Use a new key for a new request. |
| `limit_reached` | 429 | Too many requests. Wait the number of seconds in the `Retry-After` header, then go on. |
| `unavailable` | 503 | Try again later. |
| `internal` | 500 | Something went wrong on the server. Try again later; if it stays, tell whoever runs FamilyOS. |

**Limits**
- **Rate.** 300 requests a minute per key; beyond that `429` with `Retry-After` until the minute ends. Wrong keys count per address: after 30 a minute, that address is turned away for a while (`429`, `Retry-After`). Pollers: send `If-None-Match` or use `GET /changes`.
- **Ranges.** `GET /calendar/occurrences` takes at most 62 days between `from` and `to`; a longer range answers `400` with `fields`.

## Keeping it working

Version 1 only grows: operations and fields may be added, none renamed or removed. Ignore unknown fields. A breaking change would be `/api/public/v2`, announced first.
