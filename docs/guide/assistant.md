# The assistant

Answers questions in plain language and turns requests into suggestions a person approves. Open it from **Ask the assistant** on Today, **Assistant** in the side bar (phones: maybe under **More**), or `/assistant`.

Needs the permission **Ask the assistant**: Admins, Members and Supervised by default, not guests (**Settings → Family → Roles**).

- **Look up** what you may see: calendar, tasks, shopping lists and more.
- **Find by meaning** when [Search](search.md) is set up.
- **Suggest changes**: "add milk and bread to the shopping list" gives a suggestion under the answer; nothing changes until someone approves.

Try: "What's on the calendar this week?", "Which tasks are still open?", "What is on the shopping list?"

## Questions

Asked what there is ("what is on this week?", "do I need to pick up Leo on Thursday?", "what is for dinner on Friday?", "is anything waiting for me?"), FamilyOS answers from the facts:

- **First line:** what it understood: parts, people, days ("Calendar · Leo · Thursday, 22 October"). Wrong? Rephrase.
- **Facts:** per part, with notes. Tap an event, task, chore, meal or duty to open it. An empty part says so and names the next thing: "Nothing this weekend; next: Saturday, 31 October, 19:00: Date night".
- **Sentence above:** one or two sentences, checked against the facts first; dropped if it has a numeric date, a weekday that doesn't fit its date, a day or name not in the facts, or "nothing" where there is something. Facts always show.
- **Missing parts:** not installed, closed to the assistant or not yours: "Pets: not installed here".

**Good to know**
- The sentence suits the asker's description: a young child ("6 years old") gets one short sentence. [Telegram](telegram.md): one line, then plain fact lines.
- About a person: their items plus the family's; a line counts the rest ("2 more are for other people.") without showing them.
- Dinner questions also show that day's calendar.
- One message can hold several requests; questions about different days get a card each, in order. If one part fails, the rest is done and the reply says what was missed.
- A name nobody has ("Biscuit"): "No family member is called Biscuit". Only people; pets and things have their own parts.
- No part named: calendar and tasks. No days named: next 7 days.
- Overviews ("overview of this week", "open tasks") cover the whole family; it narrows to one person for "my calendar", "what do I have", "am I free", "Noah's tasks". A person's tasks include tasks anyone may do; their calendar includes family events.
- A name lookup for one person that finds nothing also shows what others have under that name.
- A span with nothing in it ("this weekend"): it says so, notes other open things fall outside, and names what comes next.
- To change or remove, name the item as before; no match means "not there", never a similar item.
- Move one date of a repeating event ("move this Sunday's planning to 18:00"): it becomes its own event and the series skips it. **Undo** reverts.

### Days and dates

FamilyOS works days out before the assistant answers (same words, same days), from a calendar around today in the family time zone.

| You say | Means |
|---|---|
| Weekday only ("Thursday") | The coming one. On that weekday: today while the time is ahead or unstated, else next week. The assistant states the date. Say "next week" for the later one |
| "This week" | Today to your week's last day (region sets the first day). On the last day: next 7 days, today included, and it says so |
| "Next week" | The whole week after this one |
| "This weekend" on Sunday | Today |

- Weekday/date mismatch ("Wednesday 20 October", a Tuesday) is caught before it answers (all installed languages; numeric dates in your region's order); it says so and asks which you mean.
- A wrong weekday in its answer is corrected. Numeric dates ("2026-10-20") become words in your format ("Tuesday 20 October") unless you wrote them so.

## What it sees

- Only what the asker may see, in areas allowed for AI (**Settings → AI → What the AI may read**). Off areas are never offered; **Local only** areas only with a model on your network.
- For an uncovered area it says it cannot see it, told why (not installed, off, closed to the AI): "Home is not installed here". It does not ask for details it can't look up.
- Names and descriptions only with **Send names and descriptions** on (Settings → AI); otherwise it can't name anyone.
- Conversations are private to each person.

## Suggestions

Cards appear under the answer, as in Quick add: those who may approve can approve, edit or reject. They also wait in Quick add under **Waiting for you** (**From the assistant**). Supervised members see **Waiting for approval**; an adult decides in Quick add, and the assistant says so. Cards show the real item name. With [auto-approval](auto-approval.md) on for the kind, the assistant says it will be added in a moment. **Undo** takes back an approval.

**Good to know**
- "Was it approved?" lists this conversation's suggestions, outcome and decider ("approved by Sofia"). Others (Quick add, other conversations, connected apps) are not reported.
- Each suggestion gets a fixed line from the suggestion itself: "Suggested, not added yet: Add shopping items: Milk, Oat milk", "Suggested, not added yet: Add a task: Pack my football kit for Thursday, 22 October", "Added automatically: …". The app shows the card instead; the line shows when cards can't, and in Telegram under the answer, even with no answer text.
- An assistant that keeps looking things up is stopped in time to answer with what it found.
- Events use existing calendar tags; new ones only if you name them.
- Name the shopping list ("add picture wire to the Hardware store list"); otherwise the first. An unknown name gets your list names.
- Follow-ups ("yes, move it to 18:00") use the events and items looked at earlier in the conversation, also after a question.
- Changing something existing changes who it is for only if you name them ("for Noah", "me", "for the whole family").

## What it remembers

"Remember that I'm vegetarian" gives a card with **Remember this**, visible and decidable only by you (not even admins). The note must say what you said; invented notes are never suggested.

- Notes: **Settings → You → Assistant memory** (linked from the Assistant page): add, **Edit**, **Forget** (tap twice). Max 280 characters each, 100 notes.
- Read only in your own conversations, and only with **Send names and descriptions** on.
- Not shared with others or with your own connected agent.

## Using the page

- **Conversations**: list on phones, column on wide screens. **New conversation**; pencil renames; **Delete this conversation** under the open one (tap twice).
- Enter sends, Shift+Enter new line (computer); send button on touch.
- **Stop waiting** only hides the indicator; the answer still arrives.
- Failures say why (off, no model, limit reached, key refused, local model needed, too slow, no answer, not allowed); **Ask again** resends your last question.
- Answers are plain text; app paths like `/calendar` become links; web addresses stay text.

## Your own agent

Members with a personal AI agent can connect it: same visibility, changes as suggestions ([Bring your own agent](mcp.md)).

## Turning it off

Admin: **Assistant chat** switch in Settings → AI. It then answers "The assistant is turned off." and sends nothing to a model. To hide it entirely, turn **Assistant** off in **Settings → Family → Extensions**.
