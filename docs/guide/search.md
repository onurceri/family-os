# Search

Search finds things by what they mean, not only by the words in their title: "the boiler warranty" finds the boiler in Home, "red lentil soup" finds the recipe, "the school trip form" finds the shared message. You search from the search box at the top of **Today** on a wide screen, or at the top of **More** on a phone, and the [assistant](assistant.md) (and AI apps connected through [MCP](mcp.md)) can use the same search.

## Turn it on

Search needs one extra model, an **embedding model**. An admin picks it in **Settings → AI → Provider & models**:

- Ollama (on your own network): `nomic-embed-text`. Run `ollama pull nomic-embed-text` first.
- OpenAI: `text-embedding-3-small`.
- Any other server that offers `/embeddings` in the OpenAI style.

Search also needs **Use AI** to be on. Until a model is set, the search box is hidden and the assistant has no search tool; nothing else changes. When you set it, FamilyOS reads what is already there in the background; a big family may need a few minutes. If you change the model later, it reads everything again (the old results stop being used).

## What is searched

| Area | What is read |
|---|---|
| Quick add | The summary and the text of items that were shared (not items you filed on a record by hand) |
| Kitchen | Recipes: title, ingredients, steps, tags, notes |
| Home | Things (name, room, brand, model, notes) and services (kind, provider, notes). Serial and account numbers are never read |
| Calendar | Event title, place and notes. Events from subscribed calendars are not read |
| Records | What needs doing (title, record, notes) and the name and label of papers, including those of vehicles and pets. The text of a paper is not read |

## Who finds what

- You find only what you may see anyway. Someone without access to Home never sees a Home result, and the assistant working for them does not either.
- Quick add items are found only by the person who shared them.
- Search follows the AI areas in **Settings → AI → What the AI may read**. An area that is **Off** is not read at all, and what was read is deleted. **Local only** areas are read only when the Search model also runs on your own network; Settings → AI says when search does not cover an area. An area you turn off in **Settings → Family → Extensions** is not read either.
- Tasks, shopping lists and chores are never searched.

## What leaves your home

To make a text searchable, the text of the areas above (and your question when you search) is sent to the embedding model you chose, like any other AI call. Pick a model on your own network if you want it to stay home. Nothing is sent without an embedding model, and every call shows up in **Settings → AI → Usage & limits → AI activity** (without the text).

## Good to know

- Search shows the best matches, not every match; ask in a short phrase.
- A new or changed record is searchable after a few seconds.
- If something stops working (a wrong key, a monthly limit), search keeps the old results and says so in Settings → AI.
