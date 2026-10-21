# AI and privacy

Quick add uses an AI model to turn what you share (a school notice, a photo of a letter, a message) into suggestions: an event, a task, things to buy. **The AI never changes anything itself.** Every suggestion waits until a person approves it, and an approved suggestion can be undone.

FamilyOS works without AI too: the calendar and lists are fully usable, and Quick add keeps what you share.

## Choose a provider

Open **Settings → AI** (admins only). Under **Providers**, press **Add provider** and choose a kind:

| Provider | Good for | Notes |
|---|---|---|
| OpenRouter | Cloud models with no hardware; pay per use | Needs an API key from openrouter.ai. Costs are tracked per call |
| Ollama (local) | Nothing leaves your home | Runs on your own computer; needs a capable machine (a Raspberry Pi is too slow). Start it with `docker compose --profile ollama up -d` and enter `http://ollama:11434/v1` as the **Address** |
| OpenAI-compatible | Any other server (LM Studio, vLLM, OpenAI, a hosted API) | Enter its **Address** and **API key** |

You can also set a provider in the server configuration with the `FAMOS_AI_*` variables (see the README). FamilyOS applies them on every start: change them and restart, and the provider follows. It shows in **Settings → AI → Provider & models** marked as set by the server configuration and cannot be changed there.

Under **Models** on the same page, pick a provider and a model for each **role**:

- **Smart** reads notices and messages and writes the suggestions.
- **Vision** reads photos and documents; it needs a model that understands images.
- **Fast** is for quick, cheap steps.
- **Speech to text** turns voice notes into text. It needs its own model from a provider that offers the OpenAI-style `/audio/transcriptions` endpoint: OpenAI (for example `whisper-1`), Groq (for example `whisper-large-v3-turbo`), OpenRouter, or a self-hosted Whisper server such as speaches or whisper.cpp (as an OpenAI-compatible provider). Ollama cannot do it. Without it, voice notes sent to Quick add (from the app or [Telegram](telegram.md)) are kept and marked as not turned into text.
- **Search** lets people and the assistant find things by meaning (see [Search](search.md)). It needs an embedding model: for example `nomic-embed-text` on Ollama, `text-embedding-3-small` on OpenAI, or any model your provider serves at `/embeddings`. Without it nothing changes.

One model for the first three is fine: leave **Choose a different model for each task** off and the one choice is used for Smart, Vision and Fast. The optional roles sit in the same card. Press **Save** at the top of the page when you are done.

Tap a provider (or **Add provider**) to open it in a panel, a sheet on phones. There **Test connection** checks the address and key without running a model, and shows how many models it found; the model fields then suggest them. You can change its name, address or key, **Remove key** deletes only the key, and **Remove** deletes the provider (roles that used it become unset).

Under **Monthly limits** a **Budget (USD)** (as reported by the provider) or a number of **Model calls** pauses AI until next month when it is reached. Months follow the family's time zone. Leave a field empty for no limit. Usage for the month, per feature, is shown under **This month**.

Keys are stored encrypted and are never shown again. Changing a provider's address removes its stored key, so a key can never be sent somewhere else by mistake. You enter it again together with the new address; if you save the new address without a key, the panel stays open and asks for it.

## What the AI sees

For each shared item, FamilyOS sends:

- what was shared: the text, the link, text files, and (if allowed) photos and PDFs;
- the date and the next two weeks of dates, the family's time zone and language, and how the family writes dates and times (see [Region and formats](region.md));
- (if allowed) the names of the family members and their "about" text, so it can suggest whom something is for;
- (for areas the AI may use) a short list of household records, up to 50 of each kind, so it can say which one a document is about: vehicles (name, plate, make, model, year, fuel), pets (name, species, breed), homes (name, rented or owned) and the things in them (brand, model, room, warranty end), open duties such as "Car insurance (Family car), due 2026-11-01". The AI sees short handles, not internal ids; no chassis numbers, addresses, amounts or notes;
- the kinds of things it may suggest (event, task, shopping items) and their fields.

It does **not** send your calendar, your lists, other shared items, email addresses, PINs or passwords. FamilyOS keeps no copy of prompts or answers, only the count, tokens and cost of each call.

JPEG, PNG and WebP photos lose their location and other metadata (EXIF, XMP, IPTC, comments) as soon as they are shared, before they are stored or sent anywhere.

## Keeping areas away from the AI

FamilyOS is split into areas, such as the calendar, the lists, chores, the kitchen, vehicles, pets, home, and records (duties and papers). Under **Settings → AI → What the AI may read → Areas the AI may use** you choose, for each area:

- **Off**: the AI never sees that area, not even its names. Its actions are not offered to the model and its data is not put in the prompt. Everything keeps working by hand.
- **Local only**: the AI may use the area, but only with a model on your own network (for example Ollama at home). FamilyOS decides this by the address of the provider that would answer. If no such model is set up for the work, the AI simply does nothing there; **it never falls back to an internet provider on its own**.
- **Any provider**: any provider you added may be used.

**Sensitive areas.** An area holding private records is marked **Private records** and start **Off**; the others start with **Any provider**. A provider counts as local when its address resolves only to your own machine or home network. Opening a sensitive area to **Any provider** asks for a confirmation (**Allow any provider**), because its data will leave your home. Choosing **Local only** needs no confirmation. Only admins can change these choices.

Only areas that are turned on in **Settings → Family → Extensions** appear, and only the ones where the AI could do something (an area with no AI actions, such as Display content, is not listed unless it is sensitive).

**Locking an area hides its duties and papers too.** Duties and papers in Records belong to the vehicle, pet or home they are attached to, so setting **Vehicles** to **Off** also hides "Car insurance (Family car)" and the papers filed under Family car from the AI, and so on for pets and the home. Papers you filed yourself with **Add to…** are never shown to the AI at all, whatever the setting. Nobody in the family loses anything: the pages, reminders and papers work as before.

**The AI has no way out.** It can only write suggestions, and every suggestion waits for a person. It cannot send a message, create a share link or contact anyone outside your home, and text that the AI writes is shown as plain text: nothing in it is opened or loaded on its own. Even if a shared document contains instructions for the AI, the worst it can lead to is a wrong suggestion that you see before anything happens.

**See what the AI did.** **Settings → AI → Usage & limits → See what the AI did** lists every time a model was asked something, newest first: when, for what (for example **Read shared items**), **which areas it looked at**, which provider and model, what it cost, and whether it worked. A call that drew on a record shows that area as well, for example **Finance** once you have opened it, so you can check that a locked area really stayed out. If a call was refused because an area is off, you see that too. It never shows what was shared or what the model answered; FamilyOS does not keep that. **Show older** loads earlier entries.

**When the AI does not answer.** **AI is not set up yet.** means no model is chosen in Settings → AI. **The AI model chosen in Settings → AI was not found at its provider** means the provider does not know that model name; an admin should choose another one. **The AI service is not answering right now** means the model is fine but its provider is down or busy; FamilyOS tries again by itself, and you can press **Try again** later. In **See what the AI did**, the same two cases read **The provider does not know the chosen model** and **The provider did not answer**.

## Privacy switches

Under **Settings → AI → What the AI may read → What the AI sees**:

- **Send photos and documents.** When off, only text is read. A share that is only a photo then shows a note saying so.
- **Send names and descriptions.** When off, the AI is told nobody's name or description. Names your message itself writes ("Ivy has the dentist") are still matched to the people in your family by FamilyOS, on your server, after the AI has answered; for anyone else, add people when you edit a suggestion.
- **Send voice notes.** When off, voice notes are kept but never sent to the speech-to-text model. Audio is sent as it was recorded, so unlike photos it cannot be stripped of anything. With OpenRouter, voice notes cannot be limited to providers that keep no data, so the next switch does not apply to them; use OpenAI, Groq or your own server if that matters.
- **Only providers that keep no data** (OpenRouter; off unless you turn it on). It is your choice, and FamilyOS never limits which model you may use. **On:** only providers that keep no data and don't train on it serve your requests; some models, including most free ones, are then unavailable. **Off:** any provider of the chosen model may serve it, under its own data rules (some store prompts for a while, some train on them). It covers reading shared items and the assistant; voice notes (above) and search are not covered.

  If a model has no such provider while this is on, nothing gets stuck: the shared item, the assistant's answer and **See what the AI did** say that no provider met the data rules, and point here. Turn this off or choose another model, then press **Try again**. After **Test connection** on an OpenRouter provider, the model list marks the models that need this off, and a note under the model says so when you pick one. If it happens while this is off, the limit comes from the privacy settings of your OpenRouter account (on openrouter.ai).

## Turning AI off

Under **Settings → AI → What the AI may read → AI**:

- **Use AI** turns every AI call off. Shared items are kept unread (**AI is off. Kept here unread.**); **Read now** reads them once AI is back on.
- Below it, single AI features (such as **Read shared items** or **Turn voice notes into text**) can be turned off on their own.

To turn Quick add off entirely instead, use **Settings → Family → Extensions**.
