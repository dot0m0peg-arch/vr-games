// Bridge room store: retried ops (same uid) apply once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomStore } from "../bridge/store.mjs";

test("an op resent with the same uid after a timeout is applied once", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-store-"));
  const store = new RoomStore({ dataDir, log: { log() {}, info() {}, warn() {}, error() {} } });
  const { user } = store.join({ name: "Phone", device: "phone" });
  const op = { t: "add", uid: "u-retry-1", obj: { id: "o1", part: "crate", label: "crate", p: [0, 0, -2], ry: 0, s: 1 } };
  const first = store.op(user.id, op);
  const again = store.op(user.id, op);
  assert.equal(again.seq, first.seq);
  assert.equal(again.duplicate, true);
  assert.equal(store.seq, first.seq);
  const other = store.op(user.id, { t: "del", uid: "u-retry-2", ids: ["o1"] });
  assert.equal(other.seq, first.seq + 1);
  store.stop?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
