// Who simulates a shared physics body (P4 ownership). Pure functions over the shared room state, so every device in a
// room computes the same owner for every body from the same records and the same users list, with no extra messages:
//   1. a held thing is simulated by the hand holding it (record.attach.user),
//   2. else by the device that last claimed it (data.physicsClaim {user, n}: a device claims what its hands come near or
//      what its own bodies hit; the claim with the biggest n wins everywhere, equal n goes to the smaller user id, so two
//      claims that cross on the wire still end the same on both sides),
//   3. else, for a thing placed onto another (record.onto), by whoever simulates that one (a cup rides with its tray),
//   4. else by the host: the present user with the smallest id (any order-free choice; everyone has the same list).
// Non-owners run the same body as a kinematic follower of the poses the owner streams (js/physics/sync.js).
// Claude (Command), Oct 26 2026.

export const CLAIM_GAP = 0.5;   // s: a device claims one body at most this often (a contested claim settles by rule 2)
export const CLAIM_REACH = 0.25; // m: a hand (or what it holds) this close to a body claims it before touching it
export const ONTO_DEPTH = 4;    // how far an onto chain is followed

// Set of user ids counted as present: everyone in the bridge's users list, plus ourselves (standalone: just us). The
// list's `online` flag is not used: the bridge broadcasts the list on join and drop only, so a device that joined and
// then opened its event stream stays marked offline on the others until the next broadcast; the bridge itself drops a
// device that has no stream for long, and that drop is broadcast, so "listed" is what present means.
export function presentUsers(users, me) {
  const ids = new Set();
  if (Array.isArray(users)) for (const u of users) if (u && typeof u.id === 'string' && u.id) ids.add(u.id);
  if (typeof me === 'string' && me) ids.add(me);
  return ids;
}

export function hostOf(present) {
  let host = null;
  for (const id of present) if (host === null || id < host) host = id;
  return host;
}

export function validClaim(c) {
  return !!c && typeof c.user === 'string' && c.user.length > 0 && Number.isFinite(c.n) && c.n >= 0 ? { user: c.user, n: c.n } : null;
}

// The claim that wins between two: bigger n, then the smaller user id. Null-safe.
export function newerClaim(a, b) {
  a = validClaim(a); b = validClaim(b);
  if (!a) return b; if (!b) return a;
  if (a.n !== b.n) return a.n > b.n ? a : b;
  return a.user <= b.user ? a : b;
}

// The effective claim on a record: the record's own data.physicsClaim merged with what this device has seen go by
// (ledger: Map id -> claim), so a stale pose stream rewriting an older claim into the record cannot steal a body back.
export function claimOf(record, ledger = null) {
  const seen = ledger && typeof ledger.get === 'function' && record ? ledger.get(record.id) ?? null : null;
  return newerClaim(seen, record?.data?.physicsClaim ?? null);
}

// The user id that simulates `record` right now. state: the room state (for onto chains). present: Set of present ids.
export function ownerOf(record, { state = null, ledger = null, present, me = null, depth = 0 } = {}) {
  if (!record) return null;
  const attach = record.attach;
  if (attach && typeof attach.user === 'string' && present.has(attach.user)) return attach.user;
  const claim = claimOf(record, ledger);
  if (claim && present.has(claim.user)) return claim.user;
  if (typeof record.onto === 'string' && depth < ONTO_DEPTH) {
    const base = state?.objects && Object.hasOwn(state.objects, record.onto) ? state.objects[record.onto] : null;
    if (base && base !== record) return ownerOf(base, { state, ledger, present, me, depth: depth + 1 });
  }
  return hostOf(present) ?? me;
}

// Which side of a contact between two bodies owned by different devices claims the other: a hand (the human touching)
// always does; between two bodies, the owner of the one whose id sorts first, so both sides agree and only one claims.
export function claimsOther(myId, otherId, { hand = false } = {}) {
  if (hand) return true;
  return typeof myId === 'string' && typeof otherId === 'string' && myId < otherId;
}
