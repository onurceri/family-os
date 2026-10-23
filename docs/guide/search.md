# Search

Finds things by meaning: "the boiler warranty" finds the boiler in Home, "red lentil soup" the recipe. Use the search box at the top of **Today** (wide screen) or **More** (phone). The [assistant](assistant.md) and [MCP](mcp.md) apps use it too.

## Turn it on

An admin picks an **embedding model** in **Settings → AI → Provider & models**:

| Provider | Model |
|---|---|
| Ollama (own network) | `nomic-embed-text`; run `ollama pull nomic-embed-text` first |
| OpenAI | `text-embedding-3-small` |
| Any server | One offering `/embeddings` in the OpenAI style |

- **Use AI** must be on. Until a model is set, the search box is hidden and the assistant has no search tool.
- Setting a model reads existing data in the background (a big family: a few minutes). Changing it later rereads everything; old results stop being used.

## What is searched

| Area | What is read |
|---|---|
| Quick add | Summary and text of shared items (not items filed on a record by hand) |
| Kitchen | Recipes: title, ingredients, steps, tags, notes |
| Home | Things (name, room, brand, model, notes), services (kind, provider, notes). Serial and account numbers never |
| Calendar | Event title, place, notes. Not subscribed calendars |
| Records | Duties (title, record, notes), names and labels of papers incl. vehicles and pets. Not the text of a paper |

Tasks, shopping lists and chores are never searched.

## Who finds what

- You find only what you may see; so does the assistant working for you.
- Quick add items: only by whoever shared them.
- **Settings → AI → What the AI may read**: **Off** areas are not read and what was read is deleted; **Local only** areas are read only if the Search model is also on your network (Settings → AI says when an area is not covered). Areas off in **Settings → Family → Extensions** are not read.

## What leaves your home

The text of these areas and your questions go to the embedding model you chose, like any AI call. Choose one on your own network to keep it home. Without a model nothing is sent. Calls show in **Settings → AI → Usage & limits → AI activity** (without text).

**Good to know**
- Shows the best matches, not all; use short phrases.
- New or changed records are searchable in seconds.
- On a wrong key or monthly limit, search keeps old results and says so in Settings → AI.
