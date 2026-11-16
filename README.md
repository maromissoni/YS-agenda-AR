# Youth Speak AR – free web app

An AR agenda and scavenger hunt that runs in the phone's browser (Safari on iPhone, Chrome on Android). No app store, no fees.

**The flow:** aim at a wall and tap **Place here** → the Youth Speak logo animates in, pinned in that spot in the room, and keeps looping → tap the logo → the agenda opens → tap a session for its brief and directions. Walk around it, even behind it: it stays where you put it.

**Scavenger hunt:** point the camera at the real pen. A small image model you train yourself recognises it, and Penkala's panel appears.

Everything is free: hosting (GitHub Pages), world tracking (8th Wall XR Engine, free licence), 3D (three.js, MIT), object recognition (TensorFlow.js, Apache 2.0) and the Lato font (Open Font License). All of it is included in this folder.

## Update the version that is already online

1. In your GitHub repository, **delete the old folders first**: open `lib/mindar`, `markers`, `print` and the file `targets.mind`, and delete each (… menu → Delete). They are no longer used.
2. Click **Add file → Upload files**, select **everything inside this folder** (Cmd+A) and drag it in. Use Chrome so the folders upload too.
3. Click **Commit changes**. Wait 1–2 minutes and reload the link on your phone. The start screen shows **Version v7**.

The first visit downloads about 9 MB (the AR engine), so use Wi-Fi the first time.

## Try it on your phone

1. Open the link, tap **Start**, and allow the camera. On iPhone also tap **Allow** for motion access: the app needs it to track the room.
2. If the banner says *Move your phone slowly from side to side*, do that for a few seconds. The engine is learning the room.
3. Stand about 1.5 m from the wall, aim the dot at it and tap **Place here**. The logo appears there.
4. Tap the logo to open the agenda. Tap it again, or **Close agenda**, to fold it away. **Move here** places it somewhere else.

**Good to know**
- A plain white wall has nothing for the camera to measure, so the agenda is placed 1.5 m in front of you, not stuck exactly onto the wall surface. If the wall has some texture (a poster, a light switch, a door frame), the app measures the real distance.
- Tracking is steadiest in good light with some objects in view (floor, furniture, doors). In a bare white corridor it can drift.
- The agenda card is about 1 m tall. To change it, edit `CARD_HEIGHT_M` near the top of `app.js`.

## Train the pen detector (free, about 20 minutes)

The app recognises the pen with a small model made in **Google Teachable Machine**. The model learns your pen from photos, so it only knows the pen you train it on.

1. Go to **teachablemachine.withgoogle.com** → **Get Started** → **Image Project** → **Standard image model**.
2. Rename *Class 1* to **Pen** and *Class 2* to **Nothing**. The name **Pen** must match `modelClass` in `content.json`.
3. **Pen** class: add 200–400 photos of the pen. Use **Webcam** on a laptop (hold the button to record) or **Upload** photos taken with your phone.
   - Show the pen at different distances, angles and lighting, in your hand and in its hiding spot.
   - Keep the pen near the middle of the picture: the app only looks at the middle of the camera view.
4. **Nothing** class: add as many photos of everything else: the walls, the floor, the room, people, hands without the pen, and **other pens** if they might be around.
5. Click **Train Model**, then test it in the **Preview** panel. Add more photos where it gets confused and train again.
6. Click **Export Model** → **Tensorflow.js**, then either:
   - **Download**: click *Download my model*, unzip it, and upload `model.json`, `metadata.json` and `weights.bin` into the `pen-model` folder of your repository; or
   - **Upload (shareable link)**: click *Upload my model*, copy the link, and put it in `content.json` as `"huntModel": "https://teachablemachine.withgoogle.com/models/…/"`.
7. Open the app → **Scavenger hunt** → **Find the objects** and point at the pen. It must see the pen for about one second before it counts.

If it triggers on the wrong things, raise `huntConfidence` in `content.json` (for example 0.95) and add more photos to **Nothing**. If it misses the real pen, lower it (for example 0.8) and add more photos to **Pen**.

The other hunt objects work the same way: add a class named **Tie**, **Parachute** or **Torpedo** in the same model. A hunt object without a class in the model simply can't be found yet.

## Change the content (no code)

Edit `content.json` on GitHub: open the file, click the pencil icon, change the text, click **Commit changes**.

- **forumTitle**: the big title on the agenda.
- **sessions**: `title`, `room`, `time`, `speaker`, `brief`. Add or remove sessions; the card grows to fit.
  `ahead` and `side` place the room on the directions map, in metres, with your back to the agenda:
  `ahead` = metres straight ahead, `side` = metres to the right (negative = to the left).
- **hunt**: the name, points, character line, fact and video of each object, and `modelClass`, the class name in the pen detector.
- **huntModel**, **huntConfidence**: where the detector is, and how sure it must be (see above).

## Change the logo animation

Phone browsers cannot play a video with a see-through background, so `logo/intro.mp4` (plays once) and `logo/loop.mp4` (repeats) each hold two black-and-white shapes side by side: the left half is where the purple goes, the right half is where the white megaphone goes. The app rebuilds the logo from them. `logo/logo.png` is the still fallback. Send new After Effects exports over to have them converted the same way.

## Add the hunt videos

Export an `.mp4` (H.264, 16:9, under about 20 seconds and 10 MB), name it `hunt_pen.mp4` and upload it into the `videos` folder. The other objects use `hunt_tie.mp4`, `hunt_parachute.mp4` and `hunt_torpedo.mp4`.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app |
| `content.json` | Agenda, hunt objects and settings – edit this |
| `pen-model/` | The pen detector from Teachable Machine (you add it) |
| `logo/` | The logo animations and still |
| `fonts/` | Lato |
| `videos/` | Hunt character videos |
| `lib/xr/` | 8th Wall XR Engine (world tracking) and its licence – do not edit |
| `lib/three/`, `lib/tf/` | three.js and TensorFlow.js – do not edit |
| `manifest.webmanifest`, `icons/` | Lets people add the app to their home screen |

## Credits

This product includes the XR Engine software developed by Niantic Spatial, Inc. Copyright © 2026 Niantic Spatial, Inc. Licensed under the XR Engine License Agreement (`lib/xr/LICENSE`), which includes the disclaimer of warranties. The licence allows free use as part of a larger project like this one; keep this notice and the licence file with the app.
