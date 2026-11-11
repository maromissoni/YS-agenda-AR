# YS Forum AR – free web app

An AR agenda and scavenger hunt that runs in the phone's browser. No app store, no fees.
Attendees scan a QR code, tap **Start**, allow the camera and point it at the agenda poster.

Everything here is free: hosting (GitHub Pages), image tracking (MindAR, MIT licence) and 3D (three.js, MIT licence).
The libraries are included in `lib/`, so the app does not depend on any outside service.

## Put it online (about 10 minutes, free)

1. Create a free account at **github.com**.
2. Click **+ → New repository**. Name it `ys-forum-ar`, choose **Public**, and click **Create repository**.
3. On the new, empty repository page, click **uploading an existing file**.
4. Open this folder on your computer, select **everything inside it** (index.html, app.js, lib, markers and so on) and drag it into the browser.
   `index.html` must end up at the top level of the repository, not inside another folder.
5. Click **Commit changes** and wait for the upload to finish.
6. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to *Deploy from a branch*, **Branch** to *main* and the folder to */ (root)*. Click **Save**.
7. After 1–2 minutes the page shows your link: `https://YOUR-USERNAME.github.io/ys-forum-ar/`.

The link is not listed anywhere, so only people you send it to will find it. The repository itself is public, which free GitHub Pages requires.

## Test it on your phone

1. Print `print/YSForum_markers_A4.pdf` at 100% (actual size) and tape the poster to a wall.
2. Open your link on the phone (Safari on iPhone, Chrome on Android) and tap **Start**. Allow camera access.
3. Point at the poster: the agenda appears on it. Tap a session; the brief opens to the right of the agenda. Tap **Directions to the room** for the map.
4. Point at the Penkala card: the found panel opens. Claim the points, open the hunt list and the leaderboard.

Make it feel like an app: **iPhone** Share → *Add to Home Screen*. **Android** Chrome menu → *Add to Home screen* / *Install app*.

## Change the content (no code)

Edit `content.json` right on GitHub: open the file, click the pencil icon, change the text, click **Commit changes**. The live link updates in about a minute.

- **sessions**: `title`, `time`, `room`, `speaker`, `brief`.
  `ahead` and `side` place the room on the map, in metres, measured with your **back to the poster**:
  `ahead` = metres straight ahead, `side` = metres to the right (negative = to the left).
- **hunt**: the text, points and video of each object. `target` is the image number in `targets.mind` (1–4).
- **sampleLeaderboard**: placeholder players until the live leaderboard is connected.

## Add the Penkala video

Export an `.mp4` (H.264, 16:9, under about 20 seconds and 10 MB), name it `hunt_pen.mp4` and upload it into the `videos` folder on GitHub.
The other objects use `hunt_tie.mp4`, `hunt_parachute.mp4` and `hunt_torpedo.mp4`. Until a file exists, a grey placeholder shows.

## Use your own poster or hunt markers

1. Go to the MindAR compiler: https://hiukim.github.io/mind-ar-js-doc/tools/compile
2. Upload the images **in this order**: agenda poster first, then the hunt objects (pen, tie, parachute, torpedo). The order is the `target` number.
3. Click **Start**, then **Download**, and replace `targets.mind` in the repository.
Busy, high-contrast images track best; big plain areas track badly.

## Going live at the forum

The same link is your live app. Before the event:
- Make a static QR code that points to the link and print it on the poster, at registration and in the welcome email.
- Test at the venue in the real light, with several phones at once.
- The live leaderboard (shared between phones) is the next step: it needs a free Firebase project.
- A custom domain such as `ar.ysforum.hr` is optional and is the only part that costs money.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app |
| `content.json` | Agenda, hunt objects and sample leaderboard – edit this |
| `targets.mind` | The compiled images the camera recognises |
| `markers/` | The marker images; `print/` has them ready to print |
| `videos/` | Character videos |
| `lib/` | MindAR and three.js (do not edit) |
| `manifest.webmanifest`, `icons/` | Lets people add the app to their home screen |
