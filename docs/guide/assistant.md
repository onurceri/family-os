# The assistant

The assistant answers questions in plain language and turns requests into suggestions that a person approves. Open it from **Ask the assistant** on the Today screen, from **Assistant** in the side bar (on phones it may sit under **More**), or at `/assistant`.

People with the permission **Ask the assistant** can use it. Admins, members and supervised members have it by default; guests do not. You can change this per role in **Settings → Family → Roles**.

## What it can do

- **Look things up** in the parts of FamilyOS you may see: the calendar, tasks, shopping lists and more.
- **Find things by meaning** when Search is set up: "which paper is about the boiler warranty?" (see [Search](search.md)).
- **Suggest changes**: "add milk and bread to the shopping list" creates a suggestion under the answer. Nothing changes until someone approves it.

When you ask it to change or remove something, it must name the item the way you did. If nothing on the calendar or the lists matches your words, it tells you it is not there instead of changing a similar item. You can also ask it to move a single date of a repeating event ("move this Sunday's planning to 18:00"): that date becomes its own event and the repeating series skips it. **Undo** puts it back.

It reads weekdays from a calendar of the days around today in the family's time zone instead of working them out. When a weekday and a date you give do not match ("Wednesday 20 October" when the 20th is a Tuesday), FamilyOS itself checks your message for this before the assistant answers (in every installed language, with numeric dates read in your region's order), so the assistant says so and asks which one you mean.

A weekday without a date ("remind me on Thursday", "what is on Saturday?") means the coming one. When it is today's own weekday, it means today while the time you mean is still ahead (or you give no time), and the same day next week once that time has passed. FamilyOS works the date out before the assistant answers, so the same words give the same date every time, and the assistant says which date it used. Say "next week" when you mean the later one.

When you ask about a span ("this weekend", "this month") and nothing falls in it, the assistant says so. If it mentions other open things, it says that they fall outside that span.

An overview ("give me an overview of this week", "show me the open tasks") covers the whole family. The assistant narrows to one person only when you ask about whose things they are: "my calendar", "what do I have", "am I free" or "Noah's tasks".

Examples to try:

- What's on the calendar this week?
- Add milk and bread to the shopping list.
- Which tasks are still open?
- What is on the shopping list?

## What it sees

The assistant sees only what the person asking may see, and only in the areas the family allows for AI (**Settings → AI → What the AI may read**). Areas that are off are never offered to it. An area set to **Local only** is available only when the model runs on your own network.

When you ask about something none of its areas covers, for example your home after the Home extension was removed, the assistant says plainly that it cannot see anything about it in FamilyOS. It does not ask you for details it could not look up anyway.

It is told people's names and descriptions only when **Send names and descriptions** is on in Settings → AI. Otherwise it cannot refer to anyone by name.

Conversations are private: each person sees only their own.

## Suggestions

Suggestions appear as the same cards as in Quick add, right under the answer. People who may approve can approve, edit or reject them there. They also wait in Quick add under **Waiting for you** (**From the assistant**), so they are not lost when you leave the conversation. Others, such as a supervised member, see **Waiting for approval**; an adult decides in Quick add, and the assistant says so. A card always shows the real name of the item it changes. When [auto-approval](auto-approval.md) is on for the kind of change, the assistant says it will be added automatically in a moment. An approved suggestion can be taken back with **Undo**.

Ask "was it approved?" and the assistant looks up the suggestions it made in this conversation, with what became of each and who decided it ("approved by Sofia"). Suggestions made elsewhere, in Quick add, another conversation or a connected app, are not its own and it does not report them.

For each suggestion, the app also keeps a fixed line written from the suggestion itself, such as "Suggested, not added yet: Add shopping items: Milk, Oat milk" (or "Added automatically: …" when auto-approval adds it), so it is right even if the assistant's wording is not. In the app the card stands for that line, so each suggestion is shown once; the line itself appears only when the cards cannot be shown, and in [Telegram](telegram.md) it comes under the answer. It is there even when the assistant ran out of steps before writing an answer.

When it suggests an event, the assistant uses the calendar tags your family already has, and adds no new tag unless you name one. To add something to a particular shopping list, name the list ("add picture wire to the Hardware store list"); without a name, the first list is used. If the name matches none of your lists, the assistant says so and names the lists you have.

A follow-up such as "yes, move it to 18:00" refers to what the conversation was just about; the assistant remembers the events and items it looked at earlier in the same conversation.

## What it remembers

Tell the assistant to remember something ("remember that I'm vegetarian") and it suggests a short note, as a card with **Remember this**. Only you can see and approve that card; nobody else, not even an admin, can decide it.

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
