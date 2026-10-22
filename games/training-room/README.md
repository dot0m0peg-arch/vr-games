# Training Room

A giant grassy field where you say what you need and it phases in. Virtual office, combat
practice yard and think tank in one. Draw something with the magic marker and the AI guesses
what it is and brings it to life.

- **Play:** https://dot0m0peg-arch.github.io/vr-games/games/training-room/
- **Status:** early access. Tested in headless Chromium on desktop and phone layouts, in an
  emulated Quest 3 (IWER), and with three devices through the laptop bridge using stand-in
  model and Whisper servers. **Not yet tested on a real headset or with a real local model.**

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

1. **Laptop:** open the localhost address. The menu shows a QR code for the phone.
2. **Headset:** open the `https://<laptop-ip>:8787/?k=KEY` address in Quest Browser and accept the
   self-signed certificate once (Advanced → Proceed). Over USB you can skip the warning:
   `adb reverse tcp:8788 tcp:8788`, then open `http://localhost:8788/?k=KEY` in the headset.
3. **Phone:** scan the QR code and accept the certificate warning once.
4. The first time, Windows asks whether Node.js may use the network: allow **Private networks**.

Devices start on different spots around the center. With a headset player in the room, the phone
acts for them: "spawn an axe in my hand" from the phone puts it in the headset player's hand, and
phone sketches appear in front of them. That makes the phone a good mic and sketch pad while
you're in the headset.

Settings live in `config.json` in the bridge data folder (`%APPDATA%\dot-training-room` on
Windows, `~/.config/dot-training-room` elsewhere): ports, room key, model, Ollama/LM Studio
address, Whisper, laptop voice and extra parts-bin folders. `bridge/config.example.json` explains
every key. Nothing is written into this repository.

### Local model

```text
ollama pull qwen2.5-coder:7b
```

Any installed model works; names containing "coder" are picked first, then "qwen". Small models
answer faster; measure on your own laptop. The bridge sends the parts catalog, the scene around
you and your words, and asks for JSON only (Ollama structured outputs; Ollama 0.31.2 or newer).
For anything outside the catalog the model designs a new part from primitive shapes ("spawn a
dragon statue"); designs are saved to the parts bin and reused. Model output is data, never code.

### Voice on the laptop (Whisper)

Run whisper.cpp's server: `whisper-server -m ggml-base.en.bin --port 8080`. Windows builds are in
the whisper.cpp releases marked `bNNNN` (`whisper-bin-x64.zip`). `small.en` recognizes better in
loud places but is slower. While you hold the talk button the device records 16 kHz audio and the
bridge forwards it to `http://127.0.0.1:8080/inference`. An OpenAI-compatible transcription server
also works (`"sttKind": "openai"`).

### The AI's voice (optional)

Set `"ttsKind": "piper"` and run Piper's HTTP server (`python3 -m piper.http_server -m
en_US-lessac-medium`, port 5000), or `"ttsKind": "openai"` for Kokoro-FastAPI on port 8880.
Without it each device uses its own browser voice, and Quest Browser may have none; replies are
always shown as captions.

### Laptop parts bin

Drop files into the bridge's `parts` folder, or add your own folders to `partsDirs`:

- `*.json` blueprints: `{ "name", "aliases", "desc", "parts": [ { "shape", "p", "s", "r", "color", "mat" } ] }`
- `*.glb` / `*.gltf` models, with an optional `<name>.part.json` sidecar (`aliases`, `size`, `holdable`, `grip`, `desc`)
- `*.js` modules exporting `default { name, aliases, size, holdable, desc, build(THREE, opts) }`.
  These run as code in your browser, so only put your own trusted code there.

## Magic marker

Draw in the air, on a laptop sheet or on the phone, then say **"make it real"**. The model guesses
what you drew and makes it, right where you drew it, at the size you drew it, and it comes alive:
fish swim, birds fly, dogs walk, balls bounce, trees sway. It tells you what it thought it was.
If it gets it wrong, say **"no, it's a gun"** and it swaps it in place, or just "undo".

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
- **Room:** "undo", "remove that", "clear everything", "make it night" (or sunset, dawn, day)

## Files

[ARCHITECTURE.md](ARCHITECTURE.md) has the module contract and the bridge API. To run the tests
(Node 22+, no install): `node --test games/training-room/tests/*.test.mjs`. three.js r185 (MIT) and
qrcode-generator (MIT) are vendored in `vendor/`. All 119 parts are original procedural geometry
made for this game.
