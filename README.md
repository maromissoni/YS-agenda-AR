# Youth Speak AR – free web app

An AR agenda and scavenger hunt that runs in the phone's browser. No app store, no fees.

**The flow:** the phone recognises the wall marker (or you place the logo on any wall) → the Youth Speak logo animates in and keeps looping → tap the logo → the agenda opens → tap a session for its brief and directions.

Everything is free: hosting (GitHub Pages), image tracking (MindAR, MIT licence), 3D (three.js, MIT licence) and the Lato font (Open Font License). All of it is included in this folder, so the app does not depend on any outside service.

## Update the version that is already online

1. Open your repository on GitHub and click **Add file → Upload files**.
2. Open this folder on your computer, select **everything inside it** (Cmd+A) and drag it into the browser. Use Chrome so the folders (`logo`, `fonts`, `lib`...) upload too.
3. Click **Commit changes**. Files with the same name are replaced.
4. Wait 1–2 minutes, then reload the link on your phone. The start screen shows **Version v5** when the new version is live.

## Put it online for the first time (about 10 minutes, free)

1. Create a free account at **github.com**, click **+ → New repository**, choose **Public** and click **Create repository**.
2. Click **uploading an existing file**, drag in everything inside this folder and click **Commit changes**.
   `index.html` must end up at the top level of the repository, not inside another folder.
3. Go to **Settings → Pages**. Set **Source** to *Deploy from a branch*, **Branch** to *main*, folder */ (root)*, and click **Save**.
4. After 1–2 minutes the page shows your link: `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`.

## Try it on your phone

Open the link in Safari (iPhone) or Chrome (Android).

- **Place the logo on a wall** (no printing needed): point the phone at a wall and tap the button. Allow the camera, and on iPhone also motion access. The logo animates in where you are pointing. Tap it to open the agenda. Tap a session, then turn the phone to the right to see the brief. Tap the logo again, or **Close agenda**, to fold the agenda away.
  This mode uses the phone's motion sensors: the logo stays put when you turn, but does not get closer when you walk.
- **Scan the printed marker**: print `print/YSForum_markers_A4.pdf` at 100% and tape the poster to a wall. The logo appears on the poster and is locked to the wall properly.

For the hunt without printing, open a card image from `markers/` on a laptop screen and scan that.

## Change the content (no code)

Edit `content.json` on GitHub: open the file, click the pencil icon, change the text, click **Commit changes**.

- **forumTitle**: the big title on the agenda.
- **sessions**: `title`, `room`, `time`, `speaker`, `brief`. Add or remove sessions; the card grows to fit.
  `ahead` and `side` place the room on the directions map, in metres, measured with your back to the wall:
  `ahead` = metres straight ahead, `side` = metres to the right (negative = to the left).
- **hunt**: the text, points and video of each object. `target` is the image number in `targets.mind` (1–4).

## Change the logo animation

The logo is one flat colour, so the app stores only its shape: `logo/intro.mp4` (plays once) and `logo/loop.mp4` (repeats) are white-on-black videos, and the app paints them in the brand purple with a see-through background. `logo/logo.png` is the still fallback.
If you re-export the animations from After Effects, send them over to be converted the same way (a normal `.mov` with alpha will not play in phone browsers).

## Use your own marker on the wall

Any flat, detailed image can be the thing the app recognises: a banner, a poster, a roll-up.

1. Go to the MindAR compiler: https://hiukim.github.io/mind-ar-js-doc/tools/compile
2. Upload the images **in this order**: the wall marker first, then the hunt objects (pen, tie, parachute, torpedo).
3. Click **Start**, then **Download**, and replace `targets.mind` in the repository.

Busy, high-contrast images track best. A logo alone on a plain background tracks badly.

## Add the hunt videos

Export an `.mp4` (H.264, 16:9, under about 20 seconds and 10 MB), name it `hunt_pen.mp4` and upload it into the `videos` folder.
The other objects use `hunt_tie.mp4`, `hunt_parachute.mp4` and `hunt_torpedo.mp4`.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app |
| `content.json` | Agenda, hunt objects and sample leaderboard – edit this |
| `logo/` | The logo animations and still |
| `fonts/` | Lato |
| `targets.mind` | The compiled images the camera recognises |
| `markers/`, `print/` | The marker images, and a PDF of them ready to print |
| `videos/` | Hunt character videos |
| `lib/` | MindAR and three.js (do not edit) |
| `manifest.webmanifest`, `icons/` | Lets people add the app to their home screen |
