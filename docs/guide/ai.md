# AI and privacy

Quick add uses an AI model to turn what you share (a notice, a photo of a letter, a message) into suggestions: event, task, shopping items. **The AI never changes anything itself.** Every suggestion waits for a person to approve it, and an approved one can be undone. Without AI, the calendar and lists work fully and Quick add keeps what you share.

## Choose a provider

Admins only.

1. Open **Settings → AI**. Under **Providers**, press **Add provider** and choose a kind.
2. Enter its details. **Test connection** checks address and key without running a model and shows how many models it found; model fields then suggest them.
3. Under **Models**, pick a provider and model for each role.
4. Press **Save** at the top.

| Provider | Good for | Notes |
|---|---|---|
| OpenRouter | Cloud models, pay per use | API key from openrouter.ai. Cost tracked per call. Has free models |
| Ollama (local) | Nothing leaves home | Needs a capable machine (not a Raspberry Pi). Start: `docker compose --profile ollama up -d`; **Address** `http://ollama:11434/v1` |
| OpenAI-compatible | LM Studio, vLLM, OpenAI, hosted APIs | **Address** and **API key** |

| Role | For | Notes |
|---|---|---|
| **Smart** | Reads notices and messages, writes suggestions | |
| **Vision** | Reads photos and documents | Model must understand images |
| **Fast** | Quick, cheap steps | |
| **Speech to text** | Voice notes to text | Own model from a provider with OpenAI-style `/audio/transcriptions`: OpenAI (`whisper-1`), Groq (`whisper-large-v3-turbo`), OpenRouter, or self-hosted Whisper (speaches, whisper.cpp) as OpenAI-compatible. Not Ollama. Without it, voice notes to Quick add (app or [Telegram](telegram.md)) are kept, marked as not turned into text |
| **Search** | Find by meaning ([Search](search.md)) | Embedding model: `nomic-embed-text` (Ollama), `text-embedding-3-small` (OpenAI), or any `/embeddings` model. Without it nothing changes |

**Good to know**
- One model for Smart, Vision and Fast: leave **Choose a different model for each task** off.
- Free OpenRouter models: after **Test connection**, type `:free` in a model field; names end in `:free`. They are slower, sometimes busy, and may be served by providers that keep what they receive (see **Only providers that keep no data** below). FamilyOS never limits your model choice. Tested and known to work for Quick add: `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3.5-super-vl:free`.
- Tap a provider to edit its name, address or key (sheet on phones). **Remove key** deletes only the key; **Remove** deletes the provider (its roles become unset).
- Keys are stored encrypted, never shown again. Changing an address removes the stored key; enter it again with the new address (saving without one keeps the panel open and asks).
- **Monthly limits**: **Budget (USD)** (as the provider reports) or **Model calls**; AI pauses until next month when reached. Months follow the family time zone. Empty means no limit. Usage per feature: **This month**.
- Providers set with `FAMOS_AI_*` variables (see [Configuration](configuration.md)) apply on every start, show as set by the server configuration, and cannot be changed in the app.

## What the AI sees

Per shared item, FamilyOS sends:
- what was shared: text, link, text files, and (if allowed) photos and PDFs;
- today's date and the next two weeks, the family's time zone, language and date/time format ([Region and formats](region.md));
- (if allowed) member names and "about" text;
- (for areas the AI may use) up to 50 household records of each kind, as short handles, not ids: vehicles (name, plate, make, model, year, fuel), pets (name, species, breed), homes (name, rented or owned) and their things (brand, model, room, warranty end), open duties like "Car insurance (Family car), due 2026-11-01". No chassis numbers, addresses, amounts or notes;
- the kinds it may suggest (event, task, shopping items) and their fields.

Never sent: your calendar, lists, other shared items, email addresses, PINs, passwords. FamilyOS keeps no prompts or answers, only each call's count, tokens and cost.

JPEG, PNG and WebP photos lose location and other metadata (EXIF, XMP, IPTC, comments) before storage or sending. This holds for every photo you upload to FamilyOS, not only those shared to Quick add: recipe photos, board photos and display photos are cleaned on the server as well.

## Keeping areas away from the AI

**Settings → AI → What the AI may read → Areas the AI may use** (admins): choose per area (calendar, lists, chores, kitchen, vehicles, pets, home, records).

| Choice | Meaning |
|---|---|
| **Off** | The AI never sees the area, not even names; its actions are not offered, its data not in prompts. Everything works by hand |
| **Local only** | Only a model on your own network (e.g. Ollama at home), judged by the provider's address. With none, the AI does nothing there; **it never falls back to an internet provider** |
| **Any provider** | Any provider you added |

**Good to know**
- Areas with private records are marked **Private records** and start **Off**; others start **Any provider**. A provider is local when its address resolves only to your machine or home network.
- Opening a sensitive area to **Any provider** asks you to confirm (**Allow any provider**); **Local only** does not.
- Only areas on in **Settings → Family → Extensions** and with AI actions are listed (sensitive ones always).
- **Locking an area hides its duties and papers.** Records' duties and papers belong to their vehicle, pet or home: **Vehicles** **Off** hides "Car insurance (Family car)" and papers under Family car; same for pets and home. Papers you filed yourself with **Add to…** are never shown to the AI. Pages, reminders and papers still work for the family.
- The AI only writes suggestions, each waiting for a person. It cannot send messages, create share links or contact anyone outside. Its text is plain text; nothing in it is opened or loaded. Instructions hidden in a shared document can at worst cause a wrong suggestion you see first.

### See what the AI did

**Settings → AI → Usage & limits → See what the AI did** lists every model call, newest first: time, purpose (e.g. **Read shared items**), **which areas it looked at** (a record's area too, e.g. **Finance**, so you can check a locked area stayed out), provider and model, cost, result. Refusals because an area is off show too. Never the shared content or answers. **Show older** loads more.

### When the AI does not answer

| Message | Meaning | In **See what the AI did** |
|---|---|---|
| **AI is not set up yet.** | No model chosen | |
| **The AI model chosen in Settings → AI was not found at its provider** | Provider does not know the model; choose another | **The provider does not know the chosen model** |
| **The AI service is not answering right now** | Provider down or busy; FamilyOS retries, or press **Try again** later | **The provider did not answer** |

## Privacy switches

**Settings → AI → What the AI may read → What the AI sees**:

| Switch | When off | Notes |
|---|---|---|
| **Send photos and documents** | Text only; a photo-only share shows a note | |
| **Send names and descriptions** | The AI gets no names or descriptions | Names your message writes ("Ivy has the dentist") are still matched to members by FamilyOS on your server after the AI answers; add other people when editing a suggestion |
| **Send voice notes** | Kept, never sent to speech-to-text | Audio is sent as recorded (cannot be stripped like photos). OpenRouter cannot limit voice notes to no-data providers; use OpenAI, Groq or your own server if that matters |
| **Only providers that keep no data** (OpenRouter; off by default) | Any provider of the model may serve it under its own rules (some store prompts, some train on them) | **On:** only providers that keep no data and don't train serve requests; some models, most free ones, become unavailable. Covers shared items and the assistant, not voice notes or search |

With **Only providers that keep no data** on and no suitable provider, the shared item, assistant answer and **See what the AI did** say no provider met the data rules and point here. Turn it off or pick another model, then **Try again**. The model list after **Test connection** marks models needing it off, with a note when you pick one. If it happens while off, the limit is your OpenRouter account's privacy settings (openrouter.ai).

## Turning AI off

**Settings → AI → What the AI may read → AI**:
- **Use AI** off stops every AI call. Shared items are kept unread (**AI is off. Kept here unread.**); **Read now** reads them once AI is back on.
- Single features (**Read shared items**, **Turn voice notes into text**) have their own switches below.
- To remove Quick add entirely: **Settings → Family → Extensions**.
