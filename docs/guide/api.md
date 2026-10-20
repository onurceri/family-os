# The API for apps and scripts

Programs can read and change your family's calendar, shopping lists, tasks, chores and board through an API. Home Assistant uses it; so can a script, a shortcut on a phone, or anything you write. This page is for whoever sets such a program up. You do not need it to use FamilyOS.

Every program has a [connected app](connected-apps.md) of its own: a key, a role that limits what it may do, and a mode that says whether its changes happen at once or wait for a person. The API gives a program nothing a person with that role could not do, and never anything only people do (approving suggestions, managing people, keys or devices).

## Set up

1. As an admin, open **Settings → You → Connected apps** and press **Add an app**. Choose a name, a role and a mode, and copy the key when it appears. It is shown once.
2. Use your FamilyOS address and the key. The API lives under `/api/public/v1`:

```bash
export FAMOS=https://family.example.com/api/public/v1
export KEY=famos_...            # the key you copied
curl -H "Authorization: Bearer $KEY" $FAMOS/
```

The key goes in the `Authorization` header and nowhere else: not in the address, and a signed-in browser session does nothing here. (The app's own API under `/api/v1` is the other way round: it takes the session, and refuses a key.) Browsers cannot call the API from another web page; it is meant for programs.

The first call, `GET /`, tells you what to expect:

```json
{
  "api": "v1",
  "familyOS": "0.2.1",
  "timeZone": "Europe/Istanbul",
  "language": "en",
  "caller": { "app": { "id": "app_…", "name": "Hall script", "mode": "apply" }, "memberId": null },
  "extensions": [{ "id": "calendar", "version": "0.2.1", "enabled": true }, …],
  "operations": [
    { "name": "calendar.createEvent", "method": "post", "path": "/api/public/v1/calendar/events",
      "summary": "Add an event", "outcome": "apply" },
    …
  ]
}
```

`operations` lists only what **this** key may do now: the app's role decides, and the member it acts for, if it named one. `outcome` is `read`, `apply` (the change is made) or `draft` (it waits for a person to approve it). An extension you switched off in **Settings → Features** shows `"enabled": false` and its operations are gone; calling one answers `404` with the code `feature_off`.

The full description of every operation is the OpenAPI document: `GET /openapi.json` on the same address, and `apps/server/public-openapi.json` in the source. Client libraries are generated from it.

## The rules every answer follows

- **Time.** The family has one time zone, and every answer carries it as `timeZone`. A moment is an RFC 3339 text with its offset (`2026-10-21T09:00:00+03:00`); a whole day is a plain date (`2026-10-21`). When you add or change something, you send the date and the time as the family writes them (`"date": "2026-10-21", "startTime": "09:00"`); the answer gives both those and the moment (`start`, `end`).
- **Ids** look like `cal_event_0192…`, `task_…`, `shop_item_…`, `chore_…`, `board_note_…`, `member_…`. Use them as they are.
- **Lists** answer `{ "items": […], "next": null, "timeZone": … }`. A list has at most 100 items a page (`?limit=` up to 500); when `next` is not null, pass it back as `?cursor=` for the next page.
- **Changes** answer `{ "status": "applied", "result": …, "timeZone": … }`, or `{ "status": "drafted", "draftId": … }` with status `202` when the change waits for a person.
- **Names.** The shopping list made when FamilyOS was installed has no name of its own; the API gives it the name in your family's language and says `"isDefault": true`.
- **Errors** are `{ "error": { "code": …, "message": … } }`. The `code` is one of a short, fixed list (below) and is what a program should act on; the `message` is for people. A request that is wrong says which fields: `"fields": [{ "path": "items[0].title", "message": "…" }]`.

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | The request is wrong; see `fields`. |
| `unauthenticated` | 401 | No valid key. |
| `forbidden` | 403 | The role (or the member it acts for) may not. `reason` says why. |
| `not_found` | 404 | There is no such thing. |
| `feature_off` | 404 | The extension is switched off. |
| `conflict` | 409 | The thing is not in a state that allows it. |
| `gone` | 410 | The changes since that cursor are no longer kept. |
| `precondition_failed` | 412 | It changed since the version you named. |
| `idempotency_mismatch` | 422 | The `Idempotency-Key` was used for another request. |
| `limit_reached` | 429 | Too many requests; wait the `Retry-After` seconds. |
| `unavailable` | 503 | Try again later. |
| `internal` | 500 | Something went wrong. |

A key may make 300 requests a minute. Wrong keys are counted per address: after 30 a minute, that address is turned away for a while.

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

An occurrence is one date of an event: `{ "eventId": …, "recurrenceId": "2026-10-28T16:00:00+03:00", … }`. The `recurrenceId` is the moment (or day) that date was due and does not change when the date is moved. A date moved out of a repeating event is an event of its own; it names the series with `seriesId`.

**Ask only when something changed.** Every list answers with an `ETag`. Send it back as `If-None-Match` and an unchanged list answers `304` with no body, which is cheap to poll:

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

# Mark a chore done for the date you saw (an app is nobody, so it says who did it)
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"dueDate":"2026-10-21","doneBy":"member_0192…"}' $FAMOS/chores/chore_0192…/complete

# Put a note on the board
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"Back at six"}' $FAMOS/board/notes
```

The same words everywhere: `POST` adds or does something (`…/complete`, `…/reopen`, `…/uncheck`), `PATCH` changes the fields you send and keeps the rest, `PUT` replaces the whole thing, `DELETE` removes it. Deleting one date of a repeating event is `DELETE …/calendar/events/{id}?occurrence=<recurrenceId>` (write `+` in an offset as `%2B` in an address); without `occurrence` the whole series goes.

**Repeat a request safely.** Add `Idempotency-Key: <something unique>` (letters, digits, `_` and `-`, up to 100). If the same request arrives again, for instance after a network error, you get the first answer back (with the header `Idempotent-Replayed: true`) and nothing happens twice. A key is yours alone, and is kept for a week.

**Change only what you saw.** Every thing has a `version` that goes up with each write. Send it as `If-Match` and a change to something that moved on is refused with `412 precondition_failed` (the current version is in `currentVersion`) instead of overwriting what someone else did. Replacing a whole thing with `PUT` always needs `If-Match`; with `PATCH` and the rest it is your choice. Every change answers with the new version in the `ETag` header.

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H 'If-Match: "v3"' -H 'Content-Type: application/json' \
  -d '{"event":{…every field…}}' $FAMOS/calendar/events/cal_event_0192…
```

## When a change waits for approval

An app in **Changes wait for approval** mode, or acting for a member whose role may only suggest (a child), does not change anything at once: the answer is `202` with a `draftId`, and the change appears among the suggestions for a person to approve. Follow it:

```bash
curl -H "Authorization: Bearer $KEY" $FAMOS/drafts/draft_0192…
```

`status` is `waiting`, `applied` (with the `result` the change would have answered), `rejected`, `undone`, `expired` or `failed`. A suggestion can be read only by the app (and the member) that made it. The API can never approve one: only a person does.

## What changed since I looked

For a program that keeps its own copy (Home Assistant), polling `GET /changes` is cheaper than reading everything again:

```bash
curl -H "Authorization: Bearer $KEY" $FAMOS/changes                 # {"changes":[],"cursor":812,…}: where "now" is
# read everything you need, then later:
curl -H "Authorization: Bearer $KEY" "$FAMOS/changes?since=812"
```

The answer lists the things that changed since the cursor, once each: `{ "extension": "calendar", "entity": "event", "id": "cal_event_…", "op": "upsert" }`; `upsert` means read it again, `delete` means it is gone for you. Ignore a kind of thing you do not know. Pass the new `cursor` next time; if `more` is true, ask again at once. You hear only of what this key may see. Changes are kept for 30 days; a cursor older than that answers `410 gone`, and the program reads everything again.

## Acting for a member

If the app may act for Leo, add `X-FamilyOS-On-Behalf-Of: <Leo's id>` and the request is Leo's: what both Leo and the app's role allow, his own things stay his, and the suggestion says "Leo via Hall script". Naming someone the app may not act for is refused (`403`, `reason: on_behalf`).

## Keeping it working

The API only grows inside version 1: new operations and new fields can appear, nothing is renamed or removed. A program should ignore fields it does not know. A change that would break programs would come as `/api/public/v2`, announced first.
