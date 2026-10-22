# Training Room

A giant grassy field where you say what you need and it phases in. Virtual office, combat
practice yard and think tank in one. Draw something with the magic marker and the AI guesses
what it is and brings it to life.

- **Play:** https://dot0m0peg-arch.github.io/vr-games/games/training-room/
- **Status:** early access. Tested in headless Chromium on desktop and phone layouts, in an
  emulated Quest 3 (IWER), and with three devices through the laptop bridge using stand-in
  model and Whisper servers. **Not yet tested on a real headset, or with a real local model,
  Whisper, Piper or Kokoro server.**

> "AI, spawn a villa to my left." · "AI, spawn an axe in my hand." ·
> "AI, spawn a deck of playing cards on a card table."

## Two ways to run it

| | Standalone (GitHub Pages) | With the laptop bridge |
| --- | --- | --- |
| Where | Open the public URL on any device | `node games/training-room/bridge/server.mjs` on the laptop |
| Brain | Built-in command parser and shape guesser | Your local model (Ollama or LM Studio), parser as fallback |
| Voice in | The browser's speech recognition where it has one (desktop and Android Chrome; it needs internet there) | Push-to-talk audio → Whisper on the laptop |
| Voice out | The browser's voice, if any | Optional laptop voice (Piper or Kokoro) |
| Devices | One device; the room is saved in that browser | Headset, laptop and phone in one shared room |
| Extras | | Laptop screen and phone camera on a big screen in VR, laptop parts bin, model-made parts saved for reuse |

The public site never talks to an AI service. Everything AI runs on your laptop.

Quest Browser's built-in speech recognition is unreliable, so in the headset voice commands need
the bridge with Whisper (typing works everywhere). The game asks for the microphone on the flat
page before you enter VR, because a permission prompt inside VR drops you out of it.

## Laptop bridge

Requirements: Node.js (22 LTS recommended). Everything else is optional.

```text
cd vr-games/games/training-room/bridge
node server.mjs            (or double-click start-bridge.cmd on Windows)
```

It prints a **room key**, the headset/phone address `https://<laptop-ip>:8787/?k=KEY` with a QR
code, and the laptop address `http://localhost:8788/?k=KEY`.

1. **Laptop:** open the localhost address. Menu → People shows a QR code for the phone (the
   bridge window prints one too).
2. **Headset:** open the `https://<laptop-ip>:8787/?k=KEY` address in Quest Browser and accept the
   self-signed certificate (Advanced → Proceed). Over USB you can skip the warning:
   `adb reverse tcp:8788 tcp:8788`, then open `http://localhost:8788/?k=KEY` in the headset.
3. **Phone:** scan the QR code and accept the certificate warning.
4. The first time, Windows asks whether Node.js may use the network: allow **Private networks**.
   The laptop's Wi-Fi must also be set to Private (Settings → Network & internet → Wi-Fi → your
   network → Network profile type: Private). Windows 11 sets new networks to Public, and on a
   Public or company network the headset and phone cannot reach the bridge; use the USB route
   (`adb reverse`) there instead.

The certificate warning can come back after the laptop moves to another network: the bridge then
makes a new certificate for its new address, and each device asks once more.

Devices start on different spots around the center. With a headset player in the room, the phone
acts for them: "spawn an axe in my hand" from the phone puts it in the headset player's hand, and
phone sketches appear in front of them. That makes the phone a good mic and sketch pad while
you're in the headset.

Settings live in `config.json` in the bridge data folder (`%APPDATA%\dot-training-room` on
Windows, `~/.config/dot-training-room` elsewhere): ports, room key, model, Ollama/LM Studio
address, Whisper, laptop voice and extra parts-bin folders. `bridge/config.example.json` explains
every key. Nothing is written into this repository. Ollama, Whisper and the laptop voice can be
started before or after the bridge; open pages notice them within a minute or two, no reload needed.

### Local model

```text
ollama pull qwen2.5-coder:7b
```

Any installed model works; names containing "coder" are picked first, then "qwen". Small models
answer faster; measure on your own laptop. The bridge sends the parts catalog, the scene around
you and your words, and asks for JSON only (Ollama structured outputs; Ollama 0.31.2 or newer).
For anything outside the catalog the model designs a new part from primitive shapes ("spawn a
dragon statue"); designs are saved to the parts bin and reused. Model output is data, never code.
For LM Studio set `"provider": "openai"` and `"openaiUrl": "http://127.0.0.1:1234/v1"` in
config.json.

### Voice on the laptop (Whisper)

Windows builds of whisper.cpp are in its releases marked `bNNNN` (`whisper-bin-x64.zip`). The zip
holds only the programs, so also download a model:
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin (or run
`models\download-ggml-model.cmd base.en` from the whisper.cpp source zip, which saves it in
`models`). Put `ggml-base.en.bin` in the zip's `Release` folder and run the server there:
`.\whisper-server -m ggml-base.en.bin --port 8080`. `small.en` (`ggml-small.en.bin`) recognizes
better in loud places but is slower. While you hold the talk button the device records 16 kHz
audio and the bridge forwards it to `http://127.0.0.1:8080/inference`. An OpenAI-compatible
transcription server also works: set `"sttKind": "openai"` and `"sttUrl"` to its
`/v1/audio/transcriptions` address.

### The AI's voice (optional)

Set `"ttsKind": "piper"` and run Piper's HTTP server on port 5000 (all three in one folder):

```text
python -m pip install "piper-tts[http]"
python -m piper.download_voices en_US-lessac-medium
python -m piper.http_server -m en_US-lessac-medium
```

(`python3` on macOS/Linux.) Or set `"ttsKind": "openai"` for Kokoro-FastAPI on port 8880.
Without it each device uses its own browser voice, and Quest Browser may have none; replies are
always shown as captions.

### Laptop parts bin

Drop files into the `parts` folder inside the bridge data folder
(`%APPDATA%\dot-training-room\parts` on Windows, `~/.config/dot-training-room/parts` elsewhere;
the bridge's `Parts:` line shows it), or add your own folders to `partsDirs` in `config.json`
(relative paths start in the data folder):

- `*.json` blueprints: `{ "name", "aliases", "desc", "parts": [ { "shape", "p", "s", "r", "color", "mat" } ] }`
- `*.glb` / `*.gltf` models, with an optional `<name>.part.json` sidecar (`aliases`, `size`, `holdable`, `grip`, `desc`)
- `*.js` modules exporting `default { name, aliases, size, holdable, desc, build(THREE, opts) }`.
  These run as code in your browser, so only put your own trusted code there.

## Laptop checks

Three commands check a setup. Each prints a PASS/FAIL table and exits with 0 (pass) or 1 (fail), so
a task runner can use them. They read the bridge data folder (`--data <dir>` picks another one) and
save their reports in its `reports` folder. Run them from the repository folder:

- `node games/training-room/bridge/doctor.mjs [--require stt,tts,vision] [--json]` checks Node.js,
  config.json, Ollama (version, models, the model the bridge uses), one real command ("AI, spawn a
  villa to my left") through that model, and the optional parts: the vision model (a drawn circle),
  the laptop voice, Whisper (the laptop voice says "spawn a crate" and Whisper must hear "crate") and
  the network (headset address, running bridge, certificate). It passes when Node.js, the settings,
  Ollama and the command work; `--require` makes optional parts required. Model calls can take 60 s
  (`--timeout <s>`).
- `node games/training-room/bridge/eval-model.mjs [--model a,b] [--threshold 0.8] [--limit n]` gives
  each model the test commands in `tests/fixtures/model-eval.json` and scores the answers. It prints
  accuracy, mean, median and p95 latency, each miss with the answer, and the recommended model (most
  accurate, then fastest). It passes when every model reaches the threshold.
- `node games/training-room/bridge/check-headset-report.mjs [--min-fps 65] [--max-age-hours 72]`
  checks the newest headset self-test report, which the game sends to the bridge: secure page, VR
  session, frame rate, both controllers or hands, microphone, bridge, and Whisper when it runs.

## Headset check

On the launch screen, **Headset check** (Device check on a laptop or phone) tests this device in
two taps: tap 1 asks for the microphone on the flat page, records 1.5 s, sends it through Whisper
when the bridge has it, and checks speech, the laptop bridge and the laptop voice; tap 2 (**Start VR
test**) enters VR with a test scene, measures the frame rate for 10 s, exits by itself and sends the
report to the laptop (`reports/headset-*.json` in the bridge data folder). The result list stays on
screen and **Copy report** works without the bridge. `check-headset-report.mjs` above grades it.

## Kingdom mode

Kingdom mode turns the field into a realm you rule in person. Tick **Kingdom mode** on the start
screen (or in Menu → Settings), or open `games/training-room/?mode=kingdom`. Each device chooses
its own mode; buildings are ordinary parts, so everyone in a shared room sees them.

- **Three advisors walk beside you:** the Master Builder on your left, the Lord Steward on your
  right and the Marshal behind him. Talk to one by title: **"Builder, build a house right here."**
  Their titles also work as wake words in wake mode.
- **Point to place.** In VR the right-hand laser reaches 40 m and a gold ring marks the ground spot;
  on a laptop it is the center of the view. "Here", "right here" and "over there" put the building
  on that ring (pushed clear of you and of other buildings).
- **Kingdom buildings:** castle, farm field, market stall, blacksmith, chapel, tavern and peasant,
  plus the existing house, cabin, wall, tower, well, windmill, barn and siege weapons.
- **Ask about the realm:** "Steward, how is the kingdom?", "how much gold do we have?", "is there
  enough food?", "Marshal, how are our defenses?", "Builder, what should we build next?" The answer
  is worked out from the buildings in the field: homes, food, gold, defense and faith.
- **Villagers** (up to 10) wander between your buildings as the realm grows, and a peasant you
  summon walks about on its own.

There is no money to spend and nothing to lose yet: it is a sandbox with advice, not a strategy
game. Advisors and villagers are drawn on each device and are not synced.

## Magic marker

Draw in the air, on a laptop sheet or on the phone, then say **"make it real"**. The model guesses
what you drew and makes it, right where you drew it, at the size you drew it, and it comes alive:
fish swim, birds fly, dogs walk, balls bounce, trees sway. It tells you what it thought it was.
If it gets it wrong, say **"no, it's a gun"** and it swaps it in place, or just "undo". Without
the laptop model, names the game does not know become a labelled crate.

- **VR:** "AI, give me a marker" (or Menu → Marker), then hold the trigger to draw.
- **Laptop:** press **F** for marker mode and drag on the sheet. Colors, Undo stroke, What is it?,
  Erase and Make it real are in the toolbar.
- **Phone:** tap **Draw**, sketch with your finger, then **Make it real** or **Send to field**.

With a vision model installed (for example `ollama pull qwen2.5vl:7b`; picked automatically) the
model looks at a picture of your sketch. With only a text model it reads an ASCII-art version.
Without the bridge, a small built-in guesser knows circles, boxes, triangles, houses, sticks,
stars, spirals, stick figures, kites, suns and faces; anything else becomes a solid cut-out of
your drawing.

Also: "what is this?" (a guess without making it), "make it a fish" (skip the guess), "make it
fly", "stop moving", "erase the drawing".

## Controls

**VR (Quest):** left stick to move (click to sprint), right stick to snap turn and teleport (push
forward, release). Squeeze to grab and hold; release to drop, or swing and release to throw.
Trigger clicks menus, flips cards and draws with a marker. **Hold A or X to talk.** **Y turns the
mic off and on** (a real mute: the mic is closed). **B opens the menu.** The left wrist shows the
mic state and what was heard.

**Laptop/desktop:** click to look, WASD to move, Shift to sprint. **Hold V to talk**, **M** mic
off/on, Enter to type a command, E grab/drop, Q throw, left click swing, Z undo, F marker.

**Phone:** hold the big talk button, use the mic switch to cut the mic, type commands, tap parts,
Draw to sketch, drag to look, Follow headset to see what the headset player sees, Share camera to
put your camera on a screen in VR.

In loud places push-to-talk works best: the mic only listens while you hold the button. Wake mode
("AI, …" with no button) is for quiet rooms.

## Things to say

- **Spawn:** "spawn three crates in front of me", "summon a red sword in my left hand", "put a monitor on the desk", "spawn a tree 20 meters away"
- **Change:** "move the villa behind me", "make the tree bigger", "paint it blue", "bring the dummy here"
- **Office:** "spawn a whiteboard", "write Q3 goals on the whiteboard", "note: call the supplier"
- **Cards:** "deal five cards", "shuffle the deck", "flip the cards"
- **Combat:** "spawn a training dummy", "give me the battle axe", then swing; hits are counted
- **Kingdom mode:** "Builder, build a castle over there", "Builder, build a farm right here", "Steward, how is the kingdom?"
- **Room:** "undo", "remove that", "clear everything", "make it night" (or sunset, dawn, day)

## Files

[ARCHITECTURE.md](ARCHITECTURE.md) has the module contract and the bridge API. To run the tests
(Node 22+, no install): `node --test games/training-room/tests/*.test.mjs`. three.js r185 (MIT) and
qrcode-generator (MIT) are vendored in `vendor/`. All 126 parts are original procedural geometry
made for this game.
