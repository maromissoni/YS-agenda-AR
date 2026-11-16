# Youth Speak AR – free web app

An AR agenda and scavenger hunt that runs in the phone's browser (Safari on iPhone, Chrome on Android). No app store, no fees.

**The flow:** aim at a wall and tap **Place here** → the Youth Speak logo animates in, pinned in that spot in the room, and keeps looping → tap the logo → the agenda opens → tap a session for its brief and directions. Walk around it, even behind it: it stays where you put it.

**Scavenger hunt:** point the camera at the real pen. An image model trained on your pen videos recognises it, and Penkala's panel appears.

Everything is free: hosting (GitHub Pages), world tracking (8th Wall XR Engine, free licence), 3D (three.js, MIT), object recognition (TensorFlow.js, Apache 2.0) and the Lato font (Open Font License). All of it is included in this folder.

## Update the version that is already online

1. If they are still there from version 6 or older, delete `lib/mindar`, `markers`, `print` and `targets.mind` in your repository (… menu → Delete). They are no longer used.
2. Click **Add file → Upload files**, select **everything inside this folder** (Cmd+A) and drag it in. Use Chrome so the folders upload too.
3. Click **Commit changes**. Wait 1–2 minutes and reload the link on your phone. The start screen shows **Version v10**.

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

## The pen detector

The `pen-model` folder already contains a detector trained on your two videos: the blue-capped ballpoint on the office desk, and the office without it. In a test with those videos as the camera, it ignored about 30 seconds of the room and recognised the pen about 3 seconds after it came into view.

**What it has learned, and what not yet**
- It only saw the pen lying on that white desk. It may miss it somewhere very different (a dark shelf, in someone's hand, in dim light).
- This is an ordinary blue-capped ballpoint, so it may also react to other pens of the same kind. At the forum, use a pen nobody else will have, or keep similar pens away from the hiding spot.
- It must see the pen in the middle of the screen for about a second before it counts.
- It loads when you open the scavenger hunt (a few seconds the first time), so it never disturbs the agenda tracking.

**To improve it**, film 20–30 seconds of the pen in its real hiding spot at the venue (different angles and distances, keep it near the middle), plus 20–30 seconds of the same area without it, and have it retrained.

**Tuning:** if it triggers on the wrong things, raise `huntConfidence` in `content.json` (for example 0.95). If it misses the real pen, lower it (for example 0.8).

**Other objects:** the detector has the classes **Pen** and **Nothing**. The tie, parachute and torpedo need their own videos and a retrain before they can be found.

**Do it yourself instead (optional):** a model made in Google Teachable Machine (teachablemachine.withgoogle.com → Image Project → classes **Pen** and **Nothing** → Train → Export → Tensorflow.js) works too. Upload its `model.json`, `metadata.json` and `weights.bin` into `pen-model`, replacing these.

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
| `pen-model/` | The pen detector (trained on your videos) |
| `logo/` | The logo animations and still |
| `fonts/` | Lato |
| `videos/` | Hunt character videos |
| `lib/xr/` | 8th Wall XR Engine (world tracking) and its licence – do not edit |
| `pen-worker.js` | Runs the pen detector in the background so it never slows down the AR view |
| `lib/three/`, `lib/tf/` | three.js and TensorFlow.js – do not edit |
| `manifest.webmanifest`, `icons/` | Lets people add the app to their home screen |

## Credits

This product includes the XR Engine software developed by Niantic Spatial, Inc. Copyright © 2026 Niantic Spatial, Inc. Licensed under the XR Engine License Agreement (`lib/xr/LICENSE`), which includes the disclaimer of warranties. The licence allows free use as part of a larger project like this one; keep this notice and the licence file with the app.

The pen detector is built on MobileNetV2 from the ONNX Model Zoo (Apache License 2.0).
