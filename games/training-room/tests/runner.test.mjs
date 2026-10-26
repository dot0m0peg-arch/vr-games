// Runner (js/runner.js) with a real Room and a fake bridge: designs on the spot (placeholder →
// real thing in place), what goes to the model, undo, "it" and corrections. Designs are learned into
// the shared part registry, so each test uses names no other test designs.
// js/config.js reads location at import, so a minimal one is set first.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.location = { search: "", href: "http://localhost/", origin: "http://localhost", pathname: "/", hostname: "localhost", protocol: "http:" };
const { Runner } = await import("../js/runner.js");
const { Room } = await import("../js/room.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// bp(name, size): a blueprint of one size-m box.
const bp = (name, size = 1, holdable = false) => ({
  name, desc: name, holdable,
  parts: [0, 1, 2].map((i) => ({ shape: "box", p: [0, size / 2, 0], s: [size, size, size], color: i ? "#333333" : "#ff0000", mat: "matte" })),
});

function harness({ command = async () => ({ intents: [], say: "" }) } = {}) {
  const room = new Room();
  let n = 0;
  const send = (op) => {
    op.uid = op.uid || `u${++n}`;
    room.apply(op, { local: true });
  };
  const designs = [];
  const commands = [];
  const net = {
    connected: true,
    design: (name, hint) => new Promise((resolve, reject) => designs.push({ name, hint, resolve, reject })),
    command: (text, ctx, opts) => {
      commands.push(text);
      return command(text, ctx, opts);
    },
    saveBlueprint: async () => ({}),
  };
  const pose = { user: "me", p: [0, 1.6, 0], yaw: 0, hands: { right: { p: [0.3, 1.2, -0.3], q: [0, 0, 0, 1] } } };
  const replies = [];
  const events = [];
  const runner = new Runner({ room, send, getNet: () => net, getPlayer: () => pose, getUser: () => "me", settings: () => ({ hand: "right" }) });
  runner.modelAvailable = true;
  runner.on("reply", (r) => replies.push(r.text));
  runner.on("done", () => events.push("done"));
  const byPart = (part) => room.records().filter((r) => r.part === part);
  // Answers the oldest open design with a blueprint and lets the runner apply it.
  const finish = async (blueprint) => {
    while (!designs.length) await flush();
    const job = designs.shift();
    job.resolve({ blueprint: { ...blueprint, name: job.name }, say: `${job.name}!` });
    for (let i = 0; i < 5; i++) await flush();
    return job;
  };
  return { room, runner, net, pose, replies, events, designs, commands, byPart, finish };
}

test("a missing thing becomes its design in place: same id, things on it stay on it", async () => {
  const h = harness();
  await h.runner.run("spawn a pirate ship and put a crate on it");
  const [marker] = h.byPart("designing");
  const [crate] = h.byPart("crate");
  assert.ok(marker && crate, JSON.stringify(h.room.records()));
  assert.equal(crate.onto, marker.id);
  assert.equal(h.commands.length, 0, "the parser understood the rest: only the design goes to the model");
  await h.finish(bp("pirate ship", 4));
  const ship = h.room.get(marker.id);
  assert.equal(ship.part, "custom:pirate-ship");
  assert.ok(ship.data.blueprint);
  assert.equal(h.room.get(crate.id).onto, ship.id, "the crate still stands on the ship");
  assert.ok(Math.abs(h.room.get(crate.id).p[1] - (ship.p[1] + 4)) < 0.01, `crate on the ship's top: ${h.room.get(crate.id).p}`);
  assert.ok(Math.hypot(ship.p[0], ship.p[2]) >= 2.29, `the 4 m ship clears the player: ${ship.p}`);
  assert.ok(Math.hypot(h.room.get(crate.id).p[0] - ship.p[0], h.room.get(crate.id).p[2] - ship.p[2]) < 0.01, "the crate moved with it");
});

test("the design keeps what was set on the marker: behavior, height, later edits and undo", async () => {
  const h = harness({
    command: async () => ({ intents: [{ do: "spawn", what: { label: "wyvern" } }, { do: "animate", target: { batch: 0 }, behavior: "fly" }], say: "" }),
  });
  await h.runner.run("conjure me a wyvern and make it fly please");
  const [marker] = h.byPart("designing");
  assert.equal(marker.data.behavior?.kind, "fly");
  await h.finish(bp("wyvern", 2));
  assert.equal(h.room.get(marker.id).data.behavior?.kind, "fly", "still flies");

  const h2 = harness();
  await h2.runner.run("give me a griffin");
  const [griffin] = h2.byPart("designing");
  const before = [...griffin.p];
  await h2.runner.run("move it left");
  const moved = [...h2.room.get(griffin.id).p];
  assert.notDeepEqual(moved, before);
  await h2.finish(bp("griffin", 0.3));
  assert.deepEqual(h2.room.get(griffin.id).p, moved, "a small design stays where the marker was moved");
  await h2.runner.run("undo");
  assert.deepEqual(h2.room.get(griffin.id).p, before, "undo of the move still works after the swap");
  await h2.runner.run("undo");
  assert.ok(!h2.room.get(griffin.id), "undo of the spawn removes the design");
});

test("a late design does not take over 'it'", async () => {
  const h = harness();
  await h.runner.run("give me a dragon");
  await h.runner.run("spawn a crate");
  await h.finish(bp("dragon", 1));
  await h.runner.run("paint it blue");
  assert.ok(h.byPart("crate")[0].color, "the crate is painted");
  assert.equal(h.byPart("custom:dragon")[0].color, undefined, "the dragon is not");
});

test("ideas, plans and hugs go to the model, not to the designer", async () => {
  const h = harness({ command: async () => ({ intents: [], say: "How about a picnic?" }) });
  for (const text of ["give me an idea for a party", "make a wish", "give me a hug"]) await h.runner.run(text);
  assert.equal(h.designs.length, 0);
  assert.equal(h.byPart("designing").length, 0);
  assert.equal(h.commands.length, 3);
});

test("chatter stays out of the model; a bare noun does not", async () => {
  const h = harness({ command: async () => ({ intents: [{ do: "spawn", what: { label: "dragon" } }], say: "" }) });
  assert.equal((await h.runner.run("bye bye")).brain, "ignored");
  assert.equal((await h.runner.run("my hand")).brain, "ignored");
  assert.equal(h.commands.length, 0);
  await h.runner.run("dragon");
  assert.ok(h.commands.length === 1 || h.designs.length === 1, "dragon reached the model or the designer");
});

test("undo of a clear made while designing brings the marker back, and it is designed again", async () => {
  const h = harness();
  await h.runner.run("spawn a basilisk");
  const [marker] = h.byPart("designing");
  await h.runner.run("clear everything");
  h.designs.shift().reject(Object.assign(new Error("gone"), { code: "aborted" }));
  for (let i = 0; i < 5; i++) await flush();
  await h.runner.run("undo");
  assert.equal(h.room.get(marker.id)?.part, "designing", "the marker is back");
  assert.equal(h.runner.adoptDesigns(), 1, "this device made it: designed again");
  assert.equal(h.runner.adoptDesigns(), 0, "not twice");
  await h.finish(bp("basilisk", 1));
  assert.equal(h.room.get(marker.id).part, "custom:basilisk");
  await h.runner.run("undo");
  assert.ok(!h.room.get(marker.id), "undo removes it: the swap is no undo step of its own");
  assert.equal(h.runner.adoptDesigns(), 0, "no loop");
});

test("only one device takes over a marker whose maker left; none while the maker is here", async () => {
  // Two devices sharing one room; the phone acts for the headset player ("by" is the headset).
  const h = harness();
  const users = [{ id: "me" }, { id: "zz-headset" }];
  h.net.users = users;
  const headsetNet = { ...h.net, users };
  const headset = new Runner({ room: h.room, send: (op) => h.room.apply(op, { local: true }), getNet: () => headsetNet, getPlayer: () => h.pose, getUser: () => "zz-headset", settings: () => ({ hand: "right" }) });
  headset.modelAvailable = true;
  h.pose.user = "zz-headset";
  await h.runner.run("give me a cockatrice");
  const [marker] = h.byPart("designing");
  assert.equal(marker.by, "zz-headset");
  assert.equal(headset.adoptDesigns(), 0, "the headset did not make it: the phone is designing it");
  // A marker whose maker is gone is taken over by the lowest connected id only.
  h.room.apply({ t: "add", obj: { id: "o-orphan", part: "designing", label: "golem", by: "gone-user", p: [3, 0, 0], ry: 0, s: 1, data: { designing: "golem" } } }, { local: true });
  assert.equal(headset.adoptDesigns(), 0, "zz-headset is not the lowest id");
  assert.equal(h.runner.adoptDesigns(), 1, "'me' is: it takes the orphan");
  assert.equal(h.runner.adoptDesigns(), 0);
  await h.finish(bp("cockatrice", 1));
  const job = await h.finish(bp("golem", 1));
  assert.equal(job.name, "golem");
  h.net.users = [];
  h.room.apply({ t: "add", obj: { id: "o-orphan2", part: "designing", label: "wyrm", by: "gone-user", p: [4, 0, 0], ry: 0, s: 1, data: { designing: "wyrm" } } }, { local: true });
  assert.equal(h.runner.adoptDesigns(), 0, "without a user list nobody guesses");
});

test("undo of an edit made to the marker keeps the design; a stacked crate goes back where it was", async () => {
  const h = harness();
  await h.runner.run("give me a hippogriff");
  const [marker] = h.byPart("designing");
  await h.runner.run("make it walk");
  assert.equal(h.room.get(marker.id).data.behavior?.kind, "walk");
  await h.finish(bp("hippogriff", 1));
  await h.runner.run("undo");
  const design = h.room.get(marker.id);
  assert.equal(design.part, "custom:hippogriff");
  assert.ok(design.data.blueprint, "still the design, not a crate");
  assert.equal(design.data.behavior, undefined, "the walk is undone");
  assert.equal(design.data.designing, undefined);

  const h2 = harness();
  await h2.runner.run("spawn a crate to my right");
  const [crate] = h2.byPart("crate");
  const ground = [...crate.p];
  await h2.runner.run("give me a kraken");
  const [kraken] = h2.byPart("designing");
  await h2.runner.run("put the crate on the kraken");
  assert.equal(h2.room.get(crate.id).onto, kraken.id);
  await h2.finish(bp("kraken", 2));
  assert.ok(h2.room.get(crate.id).p[1] > 1.9, `the crate rides on the kraken's top: ${h2.room.get(crate.id).p}`);
  await h2.runner.run("undo");
  assert.deepEqual(h2.room.get(crate.id).p, ground, "back on the ground where it was");
  await h2.runner.run("undo");
  assert.deepEqual(h2.room.get(crate.id).p, ground, "and it stays there when the kraken goes");
  assert.ok(!h2.room.get(kraken.id));
});

test("a design whose blueprint a late edit replaced gets it back", async () => {
  const h = harness();
  await h.runner.run("give me a gorgon");
  const [marker] = h.byPart("designing");
  await h.finish(bp("gorgon", 1));
  // Another device's edit, planned on the marker, lands after the swap.
  h.room.apply({ t: "set", id: marker.id, patch: { data: { designing: "gorgon", behavior: { kind: "spin", speed: 1 } } } }, { local: true });
  assert.ok(!h.room.get(marker.id).data.blueprint);
  h.runner.adoptDesigns();
  assert.ok(h.room.get(marker.id).data.blueprint, "the blueprint is back");
  assert.equal(h.room.get(marker.id).data.behavior.kind, "spin", "the edit stays");
});

test("'no, it's a chimera' after a drawing is designed, not a labelled crate", async () => {
  const h = harness({ command: async () => ({ intents: [{ do: "spawn", what: { part: "chimera", label: "chimera" } }], say: "" }) });
  h.room.apply({ t: "add", obj: { id: "d1", part: "doodle", label: "doodle", p: [0, 0, -2], ry: 0, s: 1, data: { strokes: [] } } }, { local: true });
  h.runner.lastRealized = { id: "d1", guess: "doodle", p: [0, 0, -2], drawnSize: 1 };
  await h.runner.correct("chimera");
  assert.equal(h.byPart("designing").length, 1, JSON.stringify(h.room.records()));
  assert.ok(!h.replies.some((t) => /I don't have/.test(t)), JSON.stringify(h.replies));
  await h.finish(bp("chimera", 1));
  assert.equal(h.byPart("custom:chimera").length, 1);
});

test("'done' fires when the last model call ends, not when a replaced one does", async () => {
  const waiting = [];
  const h = harness({ command: () => new Promise((resolve) => waiting.push(resolve)) });
  const first = h.runner.run("tell me something about castles");
  await flush();
  const second = h.runner.run("what do you think about dragons");
  await flush();
  waiting[0]({ intents: [], say: "late" });
  assert.equal((await first).brain, "replaced", "answered after a newer command: dropped");
  assert.equal(h.events.length, 0, "the newer command is still thinking");
  waiting[1]({ intents: [], say: "Dragons are great." });
  await second;
  assert.equal(h.events.length, 1);
  assert.ok(h.replies.includes("Dragons are great.") && !h.replies.includes("late"));
});

test("a laptop indexed part is fetched by name and spawned with its blueprint inline", async () => {
  const stock = { "flare pistol": bp("flare pistol", 0.25, true), "signal drum": bp("signal drum", 0.6) };
  const h = harness({ command: async () => ({ intents: [{ do: "spawn", what: { part: "signal drum" } }], say: "" }) });
  const asked = [];
  h.net.resolvePart = async ({ name, q }) => {
    asked.push(name || q);
    const key = name || Object.keys(stock).find((n) => String(q).toLowerCase().includes(n));
    return key && stock[key] ? { name: key, category: "weapons", aliases: [], blueprint: stock[key] } : null;
  };
  h.runner.indexedParts = 2;
  h.runner.parserFirst = true; // as on the laptop: what the parser understands skips the model
  await h.runner.run("give me a flare pistol");
  const [pistol] = h.room.records();
  assert.equal(pistol.part, "custom:flare-pistol");
  assert.ok(pistol.data.blueprint, "other devices can build it without the laptop index");
  assert.equal(h.designs.length, 0, "found, so not designed");
  assert.equal(h.commands.length, 0);
  await h.runner.run("spawn another flare pistol");
  assert.ok(!asked.slice(1).includes("flare pistol"), "the second one is not fetched by name again");
  assert.equal(h.byPart("custom:flare-pistol").length, 2);
  // A name only the bridge knew (the model's answer) is fetched before the spawn.
  h.runner.parserFirst = false;
  await h.runner.run("could you make me something loud to bang on");
  assert.equal(h.byPart("custom:signal-drum").length, 1, JSON.stringify(h.room.records().map((r) => r.part)));
  assert.equal(h.designs.length, 0);
});
