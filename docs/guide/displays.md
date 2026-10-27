# Family displays

A display (a **screen** in the app) is a wall tablet or TV that shows today's plans without anyone signing in. It can only look: it cannot change anything or sign anyone in. Screens and shared family devices are listed under **Settings → Family → Devices** (admins).

## Add a screen

1. Open **Settings → Family → Devices**, press **Add a device** and choose **A screen for the wall or a TV**.
2. Open `<your FamilyOS address>/display` in the screen's browser (the panel shows the address and a QR code). Press **Next**.
3. The screen shows **Connect this screen** and a code like `ABCD-EFGH`. Type it under **Code on the screen** and press **Next**.
4. Give it a **Name of the screen** ("Hallway"), untick what it should not show ([below](#what-it-shows)) and press **Connect the screen**.

The panel says **Hallway is connected** after a few seconds; closing it does not stop the connection. Instead of steps 2–3 you can scan the screen's QR code with your phone: it opens step 4 with the code filled in.

| What it says | What to do |
|---|---|
| **Not connected** (code ran out) | The screen shows a new code by itself; press **Type the new code**. |
| Wrong code, or no screen asking with it | The panel returns to the code step. A done step can be tapped to reopen it. |
| The screen cannot get a code | Wait 10 minutes. |

**Good to know**
- Codes last 10 minutes, with a countdown on the screen.
- One network may have 3 codes waiting and ask for 5 in 10 minutes. Screens on the home network have their own codes.

## Add a tablet or phone the family shares

A **family device** (the kitchen tablet) lets people pick their name and sign in with a PIN.

1. Press **Add a device** and choose **A tablet or phone the family shares**.
2. Open FamilyOS on it at the address shown and sign in once with your own email and password.
3. Open **Settings → Family → Devices** on it, give it a name ("Kitchen tablet") and press **Make this a family device**.

**This device** at the top of **Devices** says whether you are on a family device; **Stop using** makes it ordinary again.

## The list of devices

**The family's devices** has a row per device: **Screen** or **Family device**, name, last used. Tap a row to rename it or (screens) change what it may show, its look and its pages, then **Save**.

**Remove**, then **Tap again to remove**: the device stops working at once (a screen shows a new code). Do this when a device is lost or sold.

## What it shows

A display shows **Today** in **family mode**: no "Needs you", nothing to press, no links, bell or menu. Type is one step larger from tablet width, two on a TV.

- **Look.** **Settings → Family → Family look → Displays**: each display has a **Style** (Broadsheet, Lanes or Wall, see [Appearance](appearance.md)) and a **Theme**, or **Same as the family**. A person's own choice or trial never changes a display.
- **Names and colors.** Off by default: one column (or lane, row) for everyone, chores as one total, the next thing without "for whom". **Show names and colors of family members** gives a column per person with name, color and chores. Anyone passing can read the screen.

What appears depends on **What it may show**. Each tick is a permission to look; only usable ones are listed. All are ticked at first except **See how many suggestions are waiting**, which tells passers-by about the family's waiting work.

| Permission | What the screen shows |
|---|---|
| **See the calendar** | The next thing with its countdown, and the day (a column, lane or row per person). Without it, no day. |
| **See the chores and whose turn it is** | Today's chores as rings (in Lanes, a ring at the start of each lane). |
| **See tasks and shopping lists** | Shopping as a number with the first few things named, tasks due today in the day, open tasks in the bottom band. |
| **See the recipes and the meal plan** | Today's meals in the day and under **Kitchen**. |
| **Show the weather (Today and displays)** | Temperature, next hours and a sentence linking the weather to the day. |
| **Show family photos on a display** | A photo of the day, and the ambient mode slideshow. |
| **See how many suggestions are waiting** | A pill by the clock with the number of Quick add suggestions waiting. |
| **See the notes on the board** and **See what needs doing and the papers of records** | The board's notes and **Coming up** (duties due soon) in the bottom band. |

**Fitting the screen.** A display never scrolls. The bottom tiles (board, tasks, Home Assistant, Coming up) go under the day or in a column beside it. When a busy day does not fit, it gives up in this order:

1. Fewer things per person ("+2 more"); things already over are dropped.
2. The photo and the weather's next hours.
3. Fewer lines per tile ("+3").
4. Shopping, the kitchen, the next days, the chores.
5. Slightly smaller type, never below a person's own screen.

What you granted stays longest: a tile goes only when even the smallest type has no room; who is home and everyone's status go last. The clock, the next thing and the day always stay. Larger or landscape screens show more. When something you allowed does not fit, the panel under **Settings → Devices** says what ("Its screen has no room for Home Assistant and the chores"): use a larger screen, another style or fewer things.

## Pages

Tap the screen in the list, then under **Pages** press **Add a page**. The screen shows the pages in turn between Today's turns. Today comes first and always returns; with no pages, only Today. A page is one thing full screen, with its name and the time on top; it never scrolls and says how many more there are.

| Page | Needs | Shows |
|---|---|---|
| **The next 7 days** | *See the calendar* | Today and six days on an hour grid, today marked. A crowded stretch says how many more events it holds. |
| **Shopping** | *See tasks and shopping lists* | What is still to buy (ticked items hidden). One list: 1–3 columns by width. Several lists: a column each with its name, up to 3, and a line for the rest. |
| **Board** | *See the notes on the board* | Pinned notes first, then the newest, as papers. |
| **Photos** | *Show family photos on a display* | The family's photos with the clock and date over them; without photos, a calm clock. |
| **Around the house** | *See what the family chose to show from Home Assistant* | The values you chose to show, see [Home Assistant](home-assistant.md). |

Arrows move a page, the cross removes it. Once a page is added:

| Choice | Range | At first |
|---|---|---|
| **Today stays for** | 30 seconds to 30 minutes | 2 minutes |
| **Each page stays for** | 10 seconds to 5 minutes | 30 seconds |
| **After a touch, back to Today in** | 30 seconds to 10 minutes | 2 minutes |

**Good to know**
- A page is offered only when the screen may show what it needs. Unticking that permission removes the page from the list and is not saved.
- Dots at the bottom show where the screen is (Today, then one per page).
- A touch holds the screen where it is; after the time you set it returns to Today. Swipe sideways to move, or tap a dot. Nothing on a page can be pressed.
- A screen with pages is never taken over by ambient mode: photos come as the **Photos** page.

## Photos and weather

**Settings → Family → Photos and weather** (admins; **Devices** links to it).

**Ambient mode.** A screen without [pages](#pages) and without a touch for a while shows a slideshow, the clock, the weather and the next event; a touch returns Today. **Start after (minutes)**: 1–240, 5 at first. **Each photo stays (seconds)**: 5–600, 30 at first. Saved when you leave the field.

**Photos.**
1. Under **Photos**, press **Add photos** and choose JPEG, PNG or WebP pictures.
2. To take one off, press **Remove**, then **Remove for good?**.

- Pictures are shrunk on your device first (longest side 1920 px), so details such as the location are dropped; the server removes them again, whatever sent the picture.
- They stay on your FamilyOS. A screen shows them only with **Show family photos on a display**.
- 500 photos are kept; a screen cycles up to 200 in random order.

**Weather.** Turn on **Show the weather on Today and on displays** and choose a **Place** (search, **Use this place**; setup offers it once after you create your account).
- Open-Meteo.com is asked for the forecast with only the place's coordinates, rounded to about 1 km. Its credit is shown on the screen.
- The sky behind the weather shows sun, clouds, rain, snow, storm, fog, or a clear night. It fills the weather block, and in ambient mode without photos the whole screen. It stays still when the device asks for less motion.

## Tips for a wall tablet

- Open `/display`, then full screen (Android Chrome: **Add to Home screen**; iPad: Share, **Add to Home Screen**).
- Keep it awake and plugged in: turn off auto-lock or sleep, or use guided access or kiosk mode.
- Lower the brightness at night, or schedule the screen off.
- An old tablet, Android photo frame or fridge browser works if its browser is Chrome (or Android WebView) 106 or newer, Safari 16.4 or newer, or Firefox 114 or newer. If it says FamilyOS could not open, update the browser or the system, then tap **Try again**.
- If it shows an old state, reload; it retries by itself when the network returns.
