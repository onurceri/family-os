# Family displays

A display (a **screen** in the app) is a wall tablet or TV that shows today's plans without anyone signing in. It can only look; it cannot change anything or sign anyone in.

Screens and the family's shared tablets and phones are all listed under **Settings → Family → Devices** (admins), where **Add a device** walks you through adding either one.

## Add a screen

Adding a screen takes four short steps. You need the screen and a phone or computer where you are signed in as an admin.

1. On FamilyOS, open **Settings → Family → Devices** and press **Add a device**. It asks **What are you adding?**: choose **A screen for the wall or a TV**.
2. **Open this address on the screen.** The panel shows the address to open in the screen's web browser (`<your FamilyOS address>/display`) and a QR code of it, for a tablet that can scan it with its camera. Press **Next**.
3. **Type the code it shows.** The screen now shows **Connect this screen** and a code like `ABCD-EFGH`. Type it under **Code on the screen** and press **Next**.
4. **Choose what it may show.** Give it a **Name of the screen** such as "Hallway", untick what it should not show (see below) and press **Connect the screen**.

**Waiting for the screen**: the panel waits until the screen has picked up the code, which takes a few seconds, and then says **Hallway is connected**; the family's day appears on the screen right after. You can close the panel meanwhile, and the screen still connects. If no screen is asking with that code (the address was closed on it, for one), the panel says so. If the code runs out before the screen answers, it says **Not connected**: the screen shows a new code by itself, and **Type the new code** takes you back to the code step. If the code does not work (typed wrong, or it ran out), the panel goes back to the code step; a done step can be tapped to open it again.

### What the screen says

A screen that is not connected yet shows **Connect this screen** with the same four steps from its side: the first is done (you are looking at it), the second shows the code, an address and a QR code. Scan the QR code with your phone, or open that address: it opens **Add a device** at the last step with the code already filled in, so you only choose what it may show and press **Connect the screen**. A code is valid for ten minutes, with a countdown under it; the screen gets a new one by itself.

To keep strangers from filling up the codes, one network can have three codes waiting at once and ask for five in ten minutes. If a screen says it cannot get a code, wait for the ones it already has to run out (ten minutes) and try again. Screens on your home network have codes of their own, so strangers on the internet asking for codes never stop you connecting a screen at home.

## Add a tablet or phone the family shares

A **family device** is a tablet or phone the family shares, such as the kitchen tablet. On it, people pick their name and sign in with a PIN instead of a password. Press **Add a device** and choose **A tablet or phone the family shares**:

1. **Open FamilyOS on it**, at the address the panel shows.
2. **Sign in once** there with your own email and password.
3. **Make it a family device.** On that device, open **Settings → Family → Devices**, give it a name ("Kitchen tablet") and press **Make this a family device**. When you are on that device already, the panel has the name field and the button itself.

At the top of **Devices**, **This device** says in one sentence whether the device you are using is a family device. **Stop using** turns it back into an ordinary one.

## The list of devices

Under **The family's devices** every screen and family device has a row: what it is (**Screen** or **Family device**), its name, and when it was last used. Tap a row to open it. For a screen you can change its name and what it may show, then **Save**. To remove a device, press **Remove**, then **Tap again to remove**: it stops working at once (a screen shows a new code). Do this when a device is lost or sold.

## What it shows

A display shows **Today**, the same page the family sees at home, in **family mode**: there is no person on it, so it has no "Needs you", nothing to press and no links, no notification bell and no menu. From a tablet's width up the type is a step larger so you can read it from across the room, and on a TV-sized screen one step more.

A display has its own look. Under **Settings → Family → Family look → Displays** each display has a **Style** (Broadsheet, Lanes or Wall, see [Appearance](appearance.md)) and a **Theme**; left at **Same as the family**, it follows the family's. What a person chooses for themselves, or tries, never changes a display.

What it shows depends on what you ticked under **What it may show** when you connected it. Only permissions a display can use are listed, and each tick is a permission to look. Everything that makes up the day is ticked at first; **See how many suggestions are waiting** is not, since it tells anyone passing by about the family's waiting work, so tick it yourself if you want it on this screen:

- **See the calendar**: the next thing, with its countdown, and the day (a column, lane or row per person). Without it the display has no day at all.
- **See the chores and whose turn it is**: today's chores as rings (in Lanes, a ring at the start of each lane).
- **See tasks and shopping lists**: shopping as a number with the first few things named, the tasks due today in the day, and the open tasks in the band at the bottom.
- **See the recipes and the meal plan**: today's meals in the day and under **Kitchen**.
- **Show the weather (Today and displays)**: the temperature, the next hours and a sentence that links the weather to the day.
- **Show family photos on a display**: a photo of the day on the page, and the slideshow of ambient mode.
- **See how many suggestions are waiting**: a pill next to the clock with the number of Quick add suggestions waiting.
- **See the notes on the board** and **See what needs doing and the papers of records**: the board's notes and **Coming up** (the duties due soon) in a band at the bottom of the page.

A display always fits its screen, so it never needs scrolling, whether it is a phone held upright, a tablet or a TV. The tiles at the bottom (the board, the tasks, Home Assistant, Coming up) go wherever the page has room: under the day, or in a column of their own beside it. When a busy day does not fit, the display first shows fewer things per person, with a "+2 more" line, and leaves out things that are already over. If that is not enough, it leaves out the photo and the weather's next hours, shows fewer lines in each tile (the rest as "+3"), then leaves out shopping, the kitchen and the next days, and the chores. Only after that does it make the type a little smaller, but never smaller than on a person's own screen. What you gave the display stays longest: a tile is left out only when even the smallest type has no room for it, and who is home and everyone's status last of all. The clock, the next thing and the day always stay. A larger screen, or one in landscape, shows more.

When a display could not fit something you allowed, its panel under **Settings → Devices** says what, for example "Its screen has no room for Home Assistant and the chores". A larger screen, another style, or fewer things to show makes room.

Tap the screen in the list of devices to rename it or change these later.

By default a display shows **no names or colors** of family members. Then the day has no columns per person: everything is in one column (or one lane, or one row), chores are one total for the family, and the next thing says what and when, not for whom. Turn on **Show names and colors of family members** if you want a column per person with their name, color and chores. Anyone passing by can read the screen, so decide what you are comfortable with in the hallway.

## Pages

A screen can show more than Today. Tap the screen in the list of devices and look under **Pages**: **Add a page** lists the pages this screen may show, and the screen shows them in turn between Today's turns. Today always comes first and always comes back, so with no pages chosen the screen shows only Today, as before. A page is a full screen of one thing. The pages are:

- **The next 7 days** (needs *See the calendar*): today and the six days after it on an hour grid, today marked, so what is coming shows even on the last day of the week. A crowded stretch of the day says how many more events it holds.
- **Shopping** (needs *See tasks and shopping lists*): what is still to buy. One list fills the screen in columns (one, two or three, by the width of the screen); with several lists, each is a column with its name above, up to three, and a line says how many more lists there are. Ticked items are not shown.
- **Board** (needs *See the notes on the board*): the pinned notes first, then the newest, as papers filling the screen.
- **Photos** (needs *Show family photos on a display*): the family's photos one after the other with the clock and the date over them. Without photos it is a calm clock.
- **Around the house** (needs *See what the family chose to show from Home Assistant*): the values you chose to show from Home Assistant, see [Home Assistant](home-assistant.md).

Each page has its name and the time at the top, and does not scroll: when it has more than fits, it says how many more.

A page is offered only when the screen may show what it needs. If you untick that permission under **What it may show**, the page leaves the list and is not saved. A page that needs something the screen was not given is never shown, whatever was chosen before. Use the arrows to move a page up or down, and the cross to remove it.

Once a page is added, three choices appear:

- **Today stays for**: how long Today shows before the first page (30 seconds to 30 minutes, 2 minutes at first).
- **Each page stays for**: how long each page shows (10 seconds to 5 minutes, 30 seconds at first).
- **After a touch, back to Today in**: how long a page you touched stays before the screen goes back to Today (30 seconds to 10 minutes, 2 minutes at first).

**Save** in the panel saves the pages together with the rest.

On the screen, small dots at the bottom show where it is: one for Today and one for each page, the current one darker. A touch anywhere holds the screen where it is, so nobody is surprised while reading; after the time you chose without another touch, it goes back to Today and the turns start again. Swipe sideways to go to the next or the previous screen, or tap a dot to go straight to it. Nothing on a page can be pressed.

A screen that has pages is not taken over by **ambient mode** when nobody touches it: the photos come as the **Photos** page instead, and the pages and Today keep turning. A screen with no pages works as before: after a while without a touch, ambient mode (the photos) takes over, and a touch brings Today back.

## Photos and weather

Photos, the weather and the slideshow have their own page: **Settings → Family → Photos and weather** (admins; **Devices** links to it).

When nobody has touched a screen for a while it goes into **ambient mode**: a photo slideshow, the clock, the weather and the next event today. A touch brings Today back. On a screen that has [pages](#pages) this does not happen: the photos are one of its pages (add **Photos** under **Pages**), and the turns go on by themselves.

**Photos.** The slideshow shows pictures you add yourself:

1. Under **Photos**, press **Add photos** and choose one or more pictures from your phone or computer (JPEG, PNG or WebP).
2. Each picture is shrunk on your device before it is sent (longest side 1920 pixels), so uploads are quick and details such as the location are not kept.
3. The pictures appear in a grid. To take one off the screens, press **Remove**, then **Remove for good?**.

The photos stay on your FamilyOS; nothing is sent anywhere. A screen can only show them if it may **Show family photos on a display**. Up to 500 photos are kept, and a screen cycles through up to 200 of them in random order. Without photos, ambient mode is a calm clock.

**Weather** is off until you turn on **Show the weather on Today and on displays** and choose a **Place** (search for it and press **Use this place**; setup also offers this once, right after you create your account). FamilyOS asks Open-Meteo.com for the forecast and sends only the place's coordinates, rounded to about one kilometre; nothing else. Weather data by Open-Meteo.com is shown on the screen.

When the weather is on, the sky behind it shows the weather: sun, clouds, rain, snow, a storm, fog, or a clear night with the moon and stars. On Today, on a person's screen and on a display, the sky fills the weather block; in ambient mode without photos it fills the whole screen behind the clock. It moves gently and uses very little power; when the device asks for less motion, it stays still.

**Ambient mode** timing is on the same page: **Start after (minutes)** (1 to 240, 5 at first) and **Each photo stays (seconds)** (5 to 600, 30 at first). A change is saved as soon as you leave the field.

## Tips for a wall tablet

- Open `/display` in the browser, then use full screen (on Android, Chrome's menu has **Add to Home screen**; on iPad, Share, **Add to Home Screen** opens it without browser bars).
- Keep the screen awake and plugged in: turn off auto-lock or sleep in the tablet's settings, or use its guided-access or kiosk mode if it has one.
- Lower the brightness at night, or let the tablet's own schedule turn the screen off.
- If the page ever shows an old state, reload it. The display tries again by itself when the network comes back.
