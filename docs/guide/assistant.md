# The assistant

The assistant answers questions in plain language and turns requests into suggestions that a person approves. Open it from **Ask the assistant** on the Today screen, from **Assistant** in the side bar (on phones it may sit under **More**), or at `/assistant`.

People with the permission **Ask the assistant** can use it. Admins, members and supervised members have it by default; guests do not. You can change this per role in **Settings → Family → Roles**.

## What it can do

- **Look things up** in the parts of FamilyOS you may see: the calendar, tasks, shopping lists and more.
- **Find things by meaning** when Search is set up: "which paper is about the boiler warranty?" (see [Search](search.md)).
- **Suggest changes**: "add milk and bread to the shopping list" creates a suggestion under the answer. Nothing changes until someone approves it.

## Questions

When you ask what there is ("what is on this week?", "do I need to pick up Leo on Thursday?", "what is for dinner on Friday?", "is anything waiting for me?"), FamilyOS answers from the facts themselves:

- The first line says what it understood: the parts it looked in, the people and the days, such as "Calendar · Leo · Thursday, 22 October". If that is not what you meant, ask again in other words.
- Under it come the facts of each part, written by FamilyOS from what is there, with their notes (what to bring, where to pick someone up). Tap an event, a task, a chore, a meal or a duty to open it on its own page (the event or task opens in its details); what has no page of its own stays plain. When a part has nothing in those days, it says so and names the next thing: "Nothing this weekend; next: Saturday, 31 October, 19:00: Date night".
- A question about someone ("do I have anything on Thursday?") shows what is for them and for the whole family. When those days hold more for other people, a line says how many ("2 more are for other people.") without showing them; the calendar has them.
- A question about dinner also shows the calendar of that day, so a dinner somewhere else is there even when the meal plan is empty.
- A part that is not installed, closed to the assistant, or that you may not see gets a line saying so ("Pets: not installed here").
- Above the facts, the assistant writes a sentence or two. FamilyOS checks them against the facts first: a date written as numbers, a weekday that does not fit its date, a day or a name that is not in the facts, or "nothing" said about something that is there, and the sentence is left out. The facts below it are always shown.

The sentence is written for the person asking, as their description in the family says: someone described as a young child ("6 years old") gets one short sentence. In [Telegram](telegram.md) the sentence is one line, and the facts follow as plain lines.

A message can hold more than one thing. "Do I have anything on Thursday? I also want to remember to pack my football kit" gets the facts for Thursday and, under them, a suggestion for the kit, in one reply; "Add milk and what is for dinner tonight?" does the same the other way round. Two questions about different days ("what is on Thursday? And on Saturday?") get a card each, in the order you asked. If one part cannot be done, the other still is, and the reply tells you what was missed.

A question about someone that names a name nobody in the family has ("Biscuit") says so: "No family member is called Biscuit". The line only speaks of people: a pet or a thing is kept in its own part.

A question that names no part ("anything on Friday?") gets the calendar and the tasks of those days. A question that names no days covers the coming seven days.

When you ask it to change or remove something, it must name the item the way you did. If nothing on the calendar or the lists matches your words, it tells you it is not there instead of changing a similar item. You can also ask it to move a single date of a repeating event ("move this Sunday's planning to 18:00"): that date becomes its own event and the repeating series skips it. **Undo** puts it back.

It reads weekdays from a calendar of the days around today in the family's time zone instead of working them out. When a weekday and a date you give do not match ("Wednesday 20 October" when the 20th is a Tuesday), FamilyOS itself checks your message for this before the assistant answers (in every installed language, with numeric dates read in your region's order), so the assistant says so and asks which one you mean. Its own answers are checked the same way: dates reach it with their weekday, and if it still writes a weekday that does not fit its date, FamilyOS puts in the right one. A date it writes as numbers ("2026-10-20") is written out in words in your date format ("Tuesday 20 October"), unless you wrote it that way yourself.

A weekday without a date ("remind me on Thursday", "what is on Saturday?") means the coming one. When it is today's own weekday, it means today while the time you mean is still ahead (or you give no time), and the same day next week once that time has passed. FamilyOS works the date out before the assistant answers, so the same words give the same date every time, and the assistant says which date it used. Say "next week" when you mean the later one.

"This week" runs from today to the last day of your week (the day your region starts the week on decides which). On that last day nothing of the week is left, so the assistant takes "this week" as the coming seven days, today included, and says so. "Next week" is always the whole week after this one, and "this weekend" on a Sunday means today. FamilyOS works these days out before the assistant answers, so the same words give the same days every time.

When you ask about a span ("this weekend", "this month") and nothing falls in it, the assistant says so. If it mentions other open things, it says that they fall outside that span. When the calendar or the household's dates have nothing in the span, the assistant is told what comes next, so it can say "nothing this weekend; the next is Date night on Saturday 24 October".

An overview ("give me an overview of this week", "show me the open tasks") covers the whole family. The assistant narrows to one person only when you ask about whose things they are: "my calendar", "what do I have", "am I free" or "Noah's tasks". One person's tasks come with the tasks anyone may do, as their calendar comes with the family's events. When the assistant looks something up by name for one person and finds nothing, FamilyOS also shows it what other family members have under that name, so "when is the swimming?" is not answered with "nothing" because someone else swims.

Examples to try:

- What's on the calendar this week?
- Add milk and bread to the shopping list.
- Which tasks are still open?
- What is on the shopping list?

## What it sees

The assistant sees only what the person asking may see, and only in the areas the family allows for AI (**Settings → AI → What the AI may read**). Areas that are off are never offered to it. An area set to **Local only** is available only when the model runs on your own network.

When you ask about something none of its areas covers, for example your home after the Home extension was removed, the assistant says plainly that it cannot see anything about it in FamilyOS. FamilyOS tells it which areas are not here and why (not installed, turned off, or closed to the AI), so it can say "Home is not installed here". It does not ask you for details it could not look up anyway.

It is told people's names and descriptions only when **Send names and descriptions** is on in Settings → AI. Otherwise it cannot refer to anyone by name.

Conversations are private: each person sees only their own.

## Suggestions

Suggestions appear as the same cards as in Quick add, right under the answer. People who may approve can approve, edit or reject them there. They also wait in Quick add under **Waiting for you** (**From the assistant**), so they are not lost when you leave the conversation. Others, such as a supervised member, see **Waiting for approval**; an adult decides in Quick add, and the assistant says so. A card always shows the real name of the item it changes. When [auto-approval](auto-approval.md) is on for the kind of change, the assistant says it will be added automatically in a moment. An approved suggestion can be taken back with **Undo**.

Ask "was it approved?" and the assistant looks up the suggestions it made in this conversation, with what became of each and who decided it ("approved by Sofia"). Suggestions made elsewhere, in Quick add, another conversation or a connected app, are not its own and it does not report them.

For each suggestion, the app also keeps a fixed line written from the suggestion itself, such as "Suggested, not added yet: Add shopping items: Milk, Oat milk" (or "Suggested, not added yet: Add a task: Pack my football kit for Thursday, 22 October" when it is about a day) (or "Added automatically: …" when auto-approval adds it), so it is right even if the assistant's wording is not. In the app the card stands for that line, so each suggestion is shown once; the line itself appears only when the cards cannot be shown, and in [Telegram](telegram.md) it comes under the answer. It is there even when the assistant wrote no answer. An assistant that keeps looking things up is stopped in time to answer with what it found, rather than running out of time.

When it suggests an event, the assistant uses the calendar tags your family already has, and adds no new tag unless you name one. To add something to a particular shopping list, name the list ("add picture wire to the Hardware store list"); without a name, the first list is used. If the name matches none of your lists, the assistant says so and names the lists you have.

A follow-up such as "yes, move it to 18:00" refers to what the conversation was just about; the assistant remembers the events and items it looked at earlier in the same conversation. This works after a question too: ask what is on, then say "yes, move it". When it changes something that is already there, it changes who it is for only when your message names them ("move it to 18:00 for Noah", "me", or "for the whole family"); otherwise the people stay as they are.

## What it remembers

Tell the assistant to remember something ("remember that I'm vegetarian") and it suggests a short note, as a card with **Remember this**. Only you can see and approve that card; nobody else, not even an admin, can decide it. The note must say what you said: one the assistant made up is never suggested.

Notes are kept on **Settings → You → Assistant memory**. Open it from the link on the Assistant page. There you can add a note, **Edit** it, or **Forget** it (tap twice). A note is at most 280 characters, and you can keep up to 100.

The assistant reads your notes only in your own conversations, and only when **Send names and descriptions** is on in Settings → AI. Notes are not shared with other people, and not with an agent you connect yourself.

## Using the page

- Conversations are listed under **Conversations** on phones and in a column on wide screens. Use **New conversation** to start one. The pencil renames a conversation. **Delete this conversation** appears under the open one; tap twice.
- On a computer, Enter sends (Shift+Enter makes a new line). On a touch screen, use the send button.
- While an answer is being written you can **Stop waiting**. This only hides the indicator; the answer still arrives.
- If something goes wrong, the answer says why (turned off, no model, limit reached, key refused, local model needed, too slow, no answer, not allowed), and **Ask again** sends your last question again.

Answers are plain text. Paths inside the app, such as `/calendar`, become links; web addresses stay text and are never opened for you.

## If you have your own agent

Members who already use a personal AI agent can connect it to FamilyOS instead. It sees the same things and its changes are suggestions in the same way. See [Bring your own agent](mcp.md).

## Turning it off

An admin can turn the assistant off with the **Assistant chat** switch in Settings → AI. It then answers "The assistant is turned off." and nothing is sent to a model.

To hide it completely, turn **Assistant** off in **Settings → Family → Extensions**.
