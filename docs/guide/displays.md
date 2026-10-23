# Family displays

A display (a **screen** in the app) is a wall tablet or TV that shows today's plans without anyone signing in. It can only look; it cannot change anything or sign anyone in.

Screens and the family's shared tablets and phones are all listed under **Settings → Family → Devices** (admins), where **Add a device** walks you through adding either one.

## Add a screen

You need the screen and a phone or computer where you are signed in as an admin.

1. On FamilyOS, open **Settings → Family → Devices** and press **Add a device**. Under **What are you adding?** choose **A screen for the wall or a TV**.
2. **Open this address on the screen.** The panel shows the address to open in the screen's web browser (`<your FamilyOS address>/display`) and a QR code of it. Press **Next**.
3. **Type the code it shows.** The screen now shows **Connect this screen** and a code like `ABCD-EFGH`. Type it under **Code on the screen** and press **Next**.
4. **Choose what it may show.** Give it a **Name of the screen** such as "Hallway", untick what it should not show ([below](#what-it-shows)) and press **Connect the screen**.

The panel waits a few seconds until the screen has picked up the code, then says **Hallway is connected**, and the family's day appears on the screen. You can close the panel meanwhile; the screen still connects.

**Good to know**
- The screen shows **Connect this screen** with the same steps from its side. Scan its QR code with your phone, or open its address: it opens **Add a device** at the last step with the code filled in.
- A code is valid for ten minutes, with a countdown under it; the screen gets a new one by itself.
- If the code runs out first, the panel says **Not connected**; **Type the new code** takes you back to the code step. A wrong or expired code also sends you back to it. If no screen is asking with that code, the panel says so. A done step can be tapped to open it again.
- One network can have three codes waiting at once and ask for five in ten minutes. If a screen cannot get a code, wait ten minutes. Screens on your home network have codes of their own, so strangers on the internet never stop you connecting a screen at home.

## Add a tablet or phone the family shares

A **family device** is a tablet or phone the family shares, such as the kitchen tablet. On it, people pick their name and sign in with a PIN instead of a password.

1. Press **Add a device** and choose **A tablet or phone the family shares**.
2. **Open FamilyOS on it**, at the address the panel shows.
3. **Sign in once** there with your own email and password.
4. **Make it a family device.** On that device, open **Settings → Family → Devices**, give it a name ("Kitchen tablet") and press **Make this a family device**. (When you are on that device already, the panel has the name field and the button itself.)

At the top of **Devices**, **This device** says whether the device you are using is a family device. **Stop using** turns it back into an ordinary one.

## The list of devices

Under **The family's devices** every screen and family device has a row: what it is (**Screen** or **Family device**), its name, and when it was last used. Tap a row to open it. For a screen you can change its name and what it may show (and its look and pages, below), then **Save**.

To remove a device, press **Remove**, then **Tap again to remove**: it stops working at once (a screen shows a new code). Do this when a device is lost or sold.

## What it shows

A display shows **Today**, the same page the family sees at home, in **family mode**: no person, so no "Needs you", nothing to press, no links, no notification bell and no menu. From a tablet's width up the type is a step larger, and on a TV-sized screen one step more.

**Its look.** Under **Settings → Family → Family look → Displays** each display has a **Style** (Broadsheet, Lanes or Wall, see [Appearance](appearance.md)) and a **Theme**; left at **Same as the family**, it follows the family's. What a person chooses for themselves, or tries, never changes a display.

**What it may show.** What appears depends on what you ticked under **What it may show**. Only permissions a display can use are listed, and each tick is a permission to look. Everything that makes up the day is ticked at first, except **See how many suggestions are waiting**: it tells anyone passing by about the family's waiting work, so tick it yourself.

| Permission | What the screen shows |
|---|---|
| **See the calendar** | The next thing, with its countdown, and the day (a column, lane or row per person). Without it there is no day at all. |
| **See the chores and whose turn it is** | Today's chores as rings (in Lanes, a ring at the start of each lane). |
| **See tasks and shopping lists** | Shopping as a number with the first few things named, the tasks due today in the day, and the open tasks in the band at the bottom. |
| **See the recipes and the meal plan** | Today's meals in the day and under **Kitchen**. |
| **Show the weather (Today and displays)** | The temperature, the next hours and a sentence that links the weather to the day. |
| **Show family photos on a display** | A photo of the day on the page, and the slideshow of ambient mode. |
| **See how many suggestions are waiting** | A pill next to the clock with the number of Quick add suggestions waiting. |
| **See the notes on the board** and **See what needs doing and the papers of records** | The board's notes and **Coming up** (the duties due soon) in a band at the bottom. |

**Names and colors.** By default a display shows **no names or colors** of family members: the day is one column (or lane, or row), chores are one total, and the next thing says what and when, not for whom. Turn on **Show names and colors of family members** for a column per person with name, color and chores. Anyone passing by can read the screen, so decide what you are comfortable with in the hallway.

**Fitting the screen.** A display never scrolls, on a phone held upright, a tablet or a TV. The tiles at the bottom (the board, the tasks, Home Assistant, Coming up) go wherever there is room: under the day, or in a column beside it. When a busy day does not fit, it makes room in this order:

1. Fewer things per person, with a "+2 more" line; things already over are left out.
2. The photo and the weather's next hours.
3. Fewer lines in each tile (the rest as "+3").
4. Shopping, the kitchen and the next days, and the chores.
5. Only then a slightly smaller type, never smaller than on a person's own screen.

What you gave the display stays longest: a tile goes only when even the smallest type has no room, and who is home and everyone's status last of all. The clock, the next thing and the day always stay. A larger screen, or one in landscape, shows more.

When a display could not fit something you allowed, its panel under **Settings → Devices** says what, for example "Its screen has no room for Home Assistant and the chores". A larger screen, another style, or fewer things to show makes room.

## Pages

A screen can show more than Today. Tap the screen in the list of devices, look under **Pages** and press **Add a page**. The screen shows the pages in turn between Today's turns. Today always comes first and comes back; with no pages chosen the screen shows only Today. A page is a full screen of one thing, with its name and the time at the top. It does not scroll: when it has more than fits, it says how many more.

| Page | Needs | Shows |
|---|---|---|
| **The next 7 days** | *See the calendar* | Today and the six days after it on an hour grid, today marked. A crowded stretch says how many more events it holds. |
| **Shopping** | *See tasks and shopping lists* | What is still to buy; ticked items are not shown. One list fills the screen in columns (one, two or three, by width). Several lists are a column each with its name above, up to three, and a line says how many more. |
| **Board** | *See the notes on the board* | The pinned notes first, then the newest, as papers filling the screen. |
| **Photos** | *Show family photos on a display* | The family's photos one after the other with the clock and the date over them. Without photos, a calm clock. |
| **Around the house** | *See what the family chose to show from Home Assistant* | The values you chose to show from Home Assistant, see [Home Assistant](home-assistant.md). |

Use the arrows to move a page up or down, and the cross to remove it. Once a page is added, three choices appear:

| Choice | Range | At first |
|---|---|---|
| **Today stays for** | 30 seconds to 30 minutes | 2 minutes |
| **Each page stays for** | 10 seconds to 5 minutes | 30 seconds |
| **After a touch, back to Today in** | 30 seconds to 10 minutes | 2 minutes |

**Save** in the panel saves the pages together with the rest.

**Good to know**
- A page is offered only when the screen may show what it needs. If you untick that permission under **What it may show**, the page leaves the list and is not saved; a page whose permission is missing is never shown.
- Small dots at the bottom show where the screen is: one for Today, one for each page, the current one darker.
- A touch anywhere holds the screen where it is; after the time you chose without another touch, it goes back to Today and the turns start again. Swipe sideways for the next or previous screen, or tap a dot. Nothing on a page can be pressed.
- A screen with pages is never taken over by **ambient mode**: the photos come as the **Photos** page instead. A screen with no pages goes into ambient mode after a while without a touch, and a touch brings Today back.

## Photos and weather

Photos, the weather and the slideshow have their own page: **Settings → Family → Photos and weather** (admins; **Devices** links to it).

**Ambient mode.** When nobody has touched a screen for a while (and it has no [pages](#pages)) it shows a photo slideshow, the clock, the weather and the next event today. Timing is on the same page: **Start after (minutes)** (1 to 240, 5 at first) and **Each photo stays (seconds)** (5 to 600, 30 at first). A change is saved as soon as you leave the field.

**Photos.** The slideshow shows pictures you add yourself:

1. Under **Photos**, press **Add photos** and choose one or more pictures from your phone or computer (JPEG, PNG or WebP).
2. The pictures appear in a grid. To take one off the screens, press **Remove**, then **Remove for good?**.

**Good to know**
- Each picture is shrunk on your device before it is sent (longest side 1920 pixels), so uploads are quick and details such as the location are not kept.
- Photos stay on your FamilyOS; nothing is sent anywhere. A screen shows them only if it may **Show family photos on a display**.
- Up to 500 photos are kept; a screen cycles through up to 200 of them in random order. Without photos, ambient mode is a calm clock.

**Weather.** Off until you turn on **Show the weather on Today and on displays** and choose a **Place** (search for it and press **Use this place**; setup also offers this once, right after you create your account).

**Good to know**
- FamilyOS asks Open-Meteo.com for the forecast and sends only the place's coordinates, rounded to about one kilometre; nothing else. Weather data by Open-Meteo.com is shown on the screen.
- The sky behind the weather shows it: sun, clouds, rain, snow, a storm, fog, or a clear night with moon and stars. It fills the weather block on Today (person's screen or display); in ambient mode without photos it fills the whole screen behind the clock. It moves gently, and stays still when the device asks for less motion.

## Tips for a wall tablet

- Open `/display` in the browser, then use full screen (on Android, Chrome's menu has **Add to Home screen**; on iPad, Share, **Add to Home Screen** opens it without browser bars).
- Keep the screen awake and plugged in: turn off auto-lock or sleep in the tablet's settings, or use its guided-access or kiosk mode if it has one.
- Lower the brightness at night, or let the tablet's own schedule turn the screen off.
- If the page ever shows an old state, reload it. The display tries again by itself when the network comes back.
