# Training Room

A giant grassy field where you say what you need and it phases in. Virtual office, combat
practice yard and think tank in one.

- **Play:** https://dot0m0peg-arch.github.io/vr-games/games/training-room/
- **Status:** early access. Desktop and phone browsers were tested in headless Chromium, and the
  VR session in an emulated Quest 3 (IWER). **It has not been tested on a real headset yet.**

> "AI, spawn a villa to my left." · "AI, spawn an axe in my hand." ·
> "AI, spawn a deck of playing cards on a card table."

## Two ways to run it

| | Standalone (GitHub Pages) | With the laptop bridge |
| --- | --- | --- |
| Where | Open the public URL on any device | `node games/training-room/bridge/server.mjs` on the laptop |
| Brain | Built-in command parser | Your local coding model (Ollama or LM Studio), parser as fallback |
| Voice | Browser speech recognition where the browser has it (desktop/Android Chrome) | Push-to-talk audio → local Whisper server on the laptop |
| Devices | One device, room saved in that browser | Headset, laptop and phone in one shared room |
| Extras | | Laptop screen and phone camera on a big screen in VR, laptop parts bin, model-made parts saved for reuse |

The public site never talks to any AI service. Everything AI runs on your laptop.

## Laptop bridge

Requirements: Node.js 20 or newer. Optional: [Ollama](https://ollama.com) with a coding model,
and a [whisper.cpp](https://github.com/ggml-org/whisper.cpp) server for voice.

```text
cd vr-games/games/training-room/bridge
node server.mjs            (or double-click start-bridge.cmd on Windows)
```

The bridge prints a **room key**, the headset/phone URL (`https://<laptop-ip>:8787/?k=KEY`), a QR
code and the laptop URL (`http://localhost:8788/?k=KEY`).

1. **Laptop:** open the localhost URL. The menu shows a QR code for the phone.
2. **Headset:** open the `https://<laptop-ip>:8787/?k=KEY` URL in Quest Browser. The certificate is
   self-signed, so accept the warning once. With USB/ADB you can avoid the warning:
   `adb reverse tcp:8788 tcp:8788`, then open `http://localhost:8788/?k=KEY` in the headset.
3. **Phone:** scan the QR code, accept the certificate warning once.
4. Windows asks whether Node.js may use the network: allow **Private networks**.

Settings live in the bridge data folder (`%APPDATA%\dot-training-room\config.json` on Windows,
`~/.config/dot-training-room/` elsewhere): ports, room key, model, Ollama/LM Studio URL, Whisper URL
and extra parts-bin folders. Nothing is written into this repository.

### Local model

```text
ollama pull qwen2.5-coder:7b        (any model works; names containing "coder" are picked first)
```

The bridge sends the parts catalog, the scene around you and your words to the model and asks
for JSON only (Ollama structured outputs). The model can also design new things from primitive
shapes ("spawn a dragon statue"); those designs are saved to the parts bin and reused. Model
output is data, never code.

### Voice on the laptop (Whisper)

Run whisper.cpp's server on the laptop (`whisper-server -m ggml-base.en.bin --port 8080`). The
headset records while you hold the talk button and sends 16 kHz WAV audio to the bridge, which
forwards it to `http://127.0.0.1:8080/inference`. An OpenAI-compatible transcription server also
works (`sttKind: "openai"`).

### Laptop parts bin

Drop files into the bridge's `parts` folder (or add your own folders to `partsDirs`):

- `*.json` blueprints: `{ "name", "aliases", "desc", "parts": [ { "shape", "p", "s", "r", "color", "mat" } ] }`
- `*.glb` / `*.gltf` models, with an optional `<name>.part.json` sidecar (`aliases`, `size`, `holdable`, `grip`, `desc`)
- `*.js` modules exporting `default { name, aliases, size, holdable, desc, build(THREE, opts) }`.
  These run as code in your browser, so only put your own trusted code there.

## Controls

**VR (Quest):** left stick move (click to sprint), right stick snap turn and teleport (push
forward, release), squeeze to grab/hold (release to drop, swing to throw), trigger to click menus
and flip cards, **hold A or X to talk**, **Y turns the mic off/on**, **B opens the menu**. The
left wrist shows the mic state and what was heard.

**Desktop:** click to look, WASD to move, Shift to sprint, **hold V to talk**, **M mic off/on**,
Enter to type a command, E grab/drop, Q throw, left click swing, Z undo.

**Phone:** hold the big talk button, use the mic switch to cut the mic, type commands, tap parts,
drag to look, follow the headset player. With a headset player in the room, phone commands act for
them: "spawn an axe in my hand" puts it in the headset player's hand.

## Things to say

- Spawn: "spawn three crates in front of me", "summon a red sword in my left hand", "put a monitor on the desk", "spawn a tree 20 meters away"
- Change: "move the villa behind me", "make the tree bigger", "paint it blue", "bring the dummy here"
- Office: "spawn a whiteboard", "write Q3 goals on the whiteboard", "note: call the supplier"
- Cards: "deal five cards", "shuffle the deck", "flip the cards"
- Combat: "spawn a training dummy", "give me the battle axe", then swing; hits are counted
- Room: "undo", "remove that", "clear everything", "make it night" / "sunset" / "day"

## Files

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module contract. Tests:
`node --test games/training-room/tests/*.test.mjs`. three.js r185 (MIT) and qrcode-generator
(MIT) are vendored in `vendor/`. All parts are original procedural geometry made for this game.
