# OnBlink

Speak a phrase or open an app using only your eyes, with a regular webcam.

OnBlink is a communication aid for people who can't easily speak or type. A blink signal opens a menu, the highlight steps through your phrases, and a second signal picks one. The Mac says it out loud or opens the app. It is built on the [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra), which provides the blink detection, face landmarks and camera-based heart rate it uses.

> OnBlink is not a medical device. It does not diagnose, treat or monitor any condition, and it should not be relied on in an emergency.

## Features

- **Two ways to select.** Double blink uses SmartSpectra's built-in blink detection. Long blink (close your eyes for about a second) uses OnBlink's own eye tracking on SmartSpectra face landmarks, and is very hard to trigger by accident.
- **Your own phrases and apps.** Add, edit, reorder and test menu items. Each one either speaks a sentence or opens an app.
- **Hear the options (optional).** Each option can be spoken softly as it is highlighted, at its own volume and through a separate output such as headphones or one earbud, while the chosen phrase is spoken out loud for everyone.
- **Check-ins (optional).** If your heart rate stays well above your own level from earlier in the session, OnBlink offers a short check-in: "I am fine", "I need a break" or "I need help". It is only an offer to talk.
- **Guided setup.** A tutorial on first launch, a framing guide that waits until your face is in position, and a practice run.
- **Clear consent.** A plain-language explanation of camera use before the first session. Nothing about you is saved.

## Requirements

- macOS (OnBlink uses the built-in `say` command and opens `.app` bundles)
- Node.js 20 or newer
- A webcam
- A free SmartSpectra API key from Presage ([sign up here](https://physiology.presagetech.com/auth/login))

## Setup

```sh
git clone <this repo>
cd onblink
npm install
npm start
```

The tutorial opens on first launch and includes a step for pasting your API key. You can also add or replace it later in **Settings → Presage API key**. The key is encrypted with your macOS Keychain and stored only on your computer.

For development, you can instead put `SMARTSPECTRA_API_KEY=your_key` in a `.env` file in this folder. A key saved in Settings takes priority. `.env` is ignored by git.

To build a standalone app, run `npm run package`. It creates `release/OnBlink-darwin-<arch>/OnBlink.app`, without your `.env` or the research folder. The app is unsigned, so the first time you open it, right-click it and choose **Open**.

The first time you press Start, macOS asks for camera permission. If it was denied, allow it in **System Settings → Privacy & Security → Camera**.

## Using OnBlink

1. Press **Start** and fit your face inside the outline. OnBlink starts listening after you've held still for a moment, and pauses if you move out of view.
2. Give your signal to open the menu.
   - **Double blink:** blink, wait for "Blink again" on screen, then blink once more. Spacing can be set to Relaxed (0.4 to 1.5 s) or Quick (0.3 to 0.8 s).
   - **Long blink:** close your eyes until the bar fills, about 0.7 seconds.
3. The highlight moves down the list by itself. When your choice is highlighted, give the signal again to pick it.
4. Pick **Cancel**, or wait, and the menu closes on its own.

A session keeps running until you press **Stop**. For testing or demos, you can set it to stop automatically after 1 to 30 minutes in **Settings → Session**. You can replay the tutorial from the **Tutorial** button in the header.

### Settings

| Setting | What it does |
| --- | --- |
| Menu items | Label, Say or Open app, the text or app, Test, reorder, delete |
| Input | Double blink or long blink, and double blink spacing |
| Check-ins | On or off, and Gentle, Normal or Sensitive |
| Menu speed | How long each item stays highlighted (0.8 to 5 s) |
| Voice | Any installed macOS voice |
| Read options aloud | Speak each option as it is highlighted, with its own volume and audio output |
| Stop automatically | Never (default), or after 1, 2, 5, 15 or 30 minutes |

### Check-ins

When check-ins are on, OnBlink learns your usual heart rate during the first minute of steady readings in each session. If stable readings stay above that level for a while, it opens a check-in menu.

| Sensitivity | Above your level by | For |
| --- | --- | --- |
| Gentle | 20 bpm or 25% | 60 s |
| Normal | 15 bpm or 20% | 45 s |
| Sensitive | 10 bpm or 15% | 30 s |

Check-ins pause while the SDK reports motion or no face, wait until you are in position and not using the menu, and appear at most once every 10 minutes. Only rises trigger a check-in. During a session, **Ctrl+Shift+K** opens a test check-in so you can try it without raising your heart rate.

## Camera consent and data handling

- **Camera:** on only after you press Start, and off when you press Stop (or at an optional time limit set in Settings).
- **Processing:** video frames are analyzed by the SmartSpectra SDK. Presage's documentation says vitals are computed on-device. The SDK also makes authenticated requests to Presage's servers, for example to check the API key and usage.
- **SDK telemetry:** turned off (`enableTelemetry: false`). Presage's [telemetry and privacy document](https://github.com/Presage-Security/SmartSpectra/blob/main/docs/telemetry-and-privacy.md) says that when it is off, the SDK transmits no telemetry, and that telemetry never includes video, measured values or identifiers.
- **What OnBlink stores:** only your menu items and settings (`~/Library/Application Support/onblink/actions.json`) and your API key (encrypted, `api-key.bin` in the same folder). Delete that folder to remove everything.
- **What OnBlink never stores or sends:** video, eye or face data, or heart rate. Your heart rate level for check-ins is kept in memory and discarded when the session stops.
- **Speech:** phrases are spoken locally by macOS. Nothing is said or sent unless you pick it.
- **Consent:** the first session requires accepting a plain-language consent screen (also part of the tutorial). Check-ins are off until you turn them on.

## SmartSpectra signals used

| Signal | Used for |
| --- | --- |
| Blinking | Double blink input |
| Face landmarks | Long blink input (eye openness per eye) |
| Talking | Ignoring eye closures while speaking (long blink mode) |
| Pulse rate | Heart rate display and check-ins, using only readings the SDK marks stable |
| Validation status | Framing guide, pausing input when out of view, and pausing check-ins during motion |

## How long blink works

Each frame, OnBlink computes the eye aspect ratio (eye height over width) for each eye from the face landmarks, divides it by that eye's median over the last 3 seconds of open-eye frames, and averages the two eyes. Comparing each eye to itself handles people whose eyes naturally open different amounts.

- A closure starts when openness drops below 78% and ends after 3 frames above 88%.
- Closures from 0.7 to 2.5 seconds count as long blinks. Shorter ones are normal blinks and are ignored, and longer ones are treated as looking away.
- A closure is ignored if the head moves more than 6% of the distance between the eyes, or if the SDK reports talking.

These values were chosen from labeled recordings made with the exploratory recorder (a keypress after each blink, long blink and wink). Replaying those recordings, the detector caught all 5 deliberate long blinks, did not fire on 15 other labeled actions (normal blinks and held winks), and did not fire in a separate unlabeled recording.

### Research scripts

The [research](research) folder has the analysis scripts used for tuning. They use only the Python standard library.

- `face_parse.py` detects closures from landmarks and scores them against keypress markers (`--trace` for a per-frame view, `--csv` to export).
- `feature_search.py` ranks landmark features by how well they separate labeled actions.

Recordings are not included because they contain face landmark data.

## Project structure

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: settings, validation, speech, opening apps, key storage |
| `preload.js` | Bridge between the page and the main process (includes the SDK's preload) |
| `renderer.js` | SDK session, input modes, framing, menu, settings UI |
| `eyes.js` | Long blink detector |
| `menu.js` | Scanning menu |
| `checkin.js` | Check-in logic |
| `tutorial.js` | Onboarding tutorial |

The page can only ask the main process to run a saved action by its id. Phrases and app paths are checked when saved and looked up in the main process, so the page cannot run arbitrary commands.

## Known limitations

- macOS only.
- Results depend on lighting, camera quality and position. If double blinks are missed, try long blink, or Relaxed spacing.
- Looking down can register as a long blink, because the upper eyelids lower.
- Heart rate is a camera-based estimate and can be affected by motion and lighting.
- Thresholds were tuned on a small number of recordings from one person.

## License

MIT. The SmartSpectra SDK is a separate dependency under Presage's own license.
