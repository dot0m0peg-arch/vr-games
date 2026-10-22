// Self-signed TLS certificate for the LAN bridge, generated with Node built-ins only.
// A tiny DER encoder builds an X.509 v3 certificate (RSA 2048, sha256WithRSAEncryption) whose
// subjectAltName covers localhost, the laptop's hostname and every LAN IPv4 address, so the
// headset and phone can open https://<laptop-ip>:8787 after accepting the warning once.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OID = {
  sha256WithRSA: "1.2.840.113549.1.1.11",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectKeyId: "2.5.29.14",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

// ---------- minimal DER encoder ----------
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

export const der = {
  sequence: (...items) => tlv(0x30, Buffer.concat(items)),
  set: (...items) => tlv(0x31, Buffer.concat(items)),
  // Unsigned big-endian integer from a Buffer or a non-negative safe integer.
  integer(value) {
    let bytes = Buffer.isBuffer(value) ? value : Buffer.from(bigToBytes(BigInt(value)));
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    bytes = bytes.subarray(i);
    if (!bytes.length) bytes = Buffer.from([0]);
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return tlv(0x02, bytes);
  },
  oid(text) {
    const parts = text.split(".").map(Number);
    const out = [40 * parts[0] + parts[1]];
    for (const value of parts.slice(2)) {
      const chunk = [value & 0x7f];
      let rest = Math.floor(value / 128);
      while (rest > 0) {
        chunk.unshift((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
      }
      out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
  },
  utf8: (text) => tlv(0x0c, Buffer.from(String(text), "utf8")),
  printable: (text) => tlv(0x13, Buffer.from(String(text), "ascii")),
  ia5: (text) => tlv(0x16, Buffer.from(String(text), "ascii")),
  // UTCTime for 1950-2049, GeneralizedTime otherwise (RFC 5280 4.1.2.5).
  time(date) {
    const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
    const year = date.getUTCFullYear();
    return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), "ascii")) : tlv(0x18, Buffer.from(iso, "ascii"));
  },
  bitString: (bytes, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes])),
  octetString: (bytes) => tlv(0x04, bytes),
  boolean: (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  null: () => Buffer.from([0x05, 0x00]),
  // Context-specific tag [n]: constructed (EXPLICIT wrapper) or primitive (IMPLICIT value).
  context: (n, content, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, content),
};

function bigToBytes(value) {
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  return bytes;
}

function toPem(label, buffer) {
  const body = buffer.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// ---------- network names ----------
const VIRTUAL_IF = /(vethernet|virtualbox|vmware|vmnet|wsl|docker|br-|veth|hyper-v|loopback|tailscale|zerotier|utun|vboxnet)/i;

function ipScore(address, ifname) {
  let score = 0;
  if (address.startsWith("192.168.")) score += 30;
  else if (address.startsWith("10.")) score += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 10;
  if (address.startsWith("169.254.")) score -= 50;
  if (address.startsWith("192.168.56.")) score -= 15; // VirtualBox host-only default
  if (VIRTUAL_IF.test(ifname)) score -= 25;
  if (/^(wi-?fi|wlan|wl|en0|eth|ethernet|en)/i.test(ifname)) score += 5;
  return score;
}

// Every non-internal IPv4 address as { address, ifname, virtual }, best LAN candidate
// (Wi-Fi/Ethernet, private range) first. virtual: VM/WSL/VPN adapters and link-local addresses.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [ifname, list] of Object.entries(interfaces || {})) {
    for (const entry of list || []) {
      const v4 = entry.family === "IPv4" || entry.family === 4;
      if (!v4 || entry.internal || !entry.address || found.some((f) => f.address === entry.address)) continue;
      const virtual = VIRTUAL_IF.test(ifname) || entry.address.startsWith("169.254.");
      found.push({ address: entry.address, ifname, virtual, score: ipScore(entry.address, ifname) });
    }
  }
  return found.sort((a, b) => b.score - a.score).map(({ address, ifname, virtual }) => ({ address, ifname, virtual }));
}

export function lanIPs(interfaces) {
  return lanAddresses(interfaces).map((a) => a.address);
}

function hostNames() {
  const host = String(os.hostname() || "").trim();
  const names = ["localhost"];
  if (/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) {
    names.push(host.toLowerCase());
    if (!host.includes(".")) names.push(`${host.toLowerCase()}.local`);
  }
  return names;
}

function ipBytes(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(parts);
}

// ---------- certificate ----------
// Returns { key, cert } PEM strings. names: DNS names, ips: IPv4 strings, days: validity.
export function generateCert({ names, ips, days = 397, commonName = "Training Room bridge" } = {}) {
  const dnsNames = [...new Set((names || hostNames()).map((n) => String(n).toLowerCase()).filter((n) => /^[a-z0-9*][a-z0-9.-]*$/.test(n)))];
  const ipList = [...new Set(ips || ["127.0.0.1", ...lanIPs()])].filter((ip) => ipBytes(ip));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const spki = publicKey.export({ type: "spki", format: "der" });

  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive and non-zero leading byte
  const algorithm = der.sequence(der.oid(OID.sha256WithRSA), der.null());
  const name = der.sequence(
    der.set(der.sequence(der.oid(OID.organization), der.utf8("DOT Games"))),
    der.set(der.sequence(der.oid(OID.commonName), der.utf8(commonName))),
  );
  const now = Date.now();
  const notBefore = new Date(now - 24 * 3600 * 1000);
  const notAfter = new Date(now + days * 24 * 3600 * 1000);

  const altNames = [
    ...dnsNames.map((n) => der.context(2, Buffer.from(n, "ascii"), false)),
    ...ipList.map((ip) => der.context(7, ipBytes(ip), false)),
  ];
  // subjectPublicKey bits inside the SPKI, hashed for the subject key identifier.
  const keyId = crypto.createHash("sha1").update(publicKey.export({ type: "pkcs1", format: "der" })).digest();
  const extension = (oid, value, critical = false) =>
    der.sequence(der.oid(oid), ...(critical ? [der.boolean(true)] : []), der.octetString(value));
  const extensions = der.sequence(
    extension(OID.subjectAltName, der.sequence(...altNames)),
    extension(OID.basicConstraints, der.sequence(), true), // CA:FALSE (DEFAULT omitted in DER)
    extension(OID.keyUsage, der.bitString(Buffer.from([0xa0]), 5), true), // digitalSignature, keyEncipherment
    extension(OID.extKeyUsage, der.sequence(der.oid(OID.serverAuth))),
    extension(OID.subjectKeyId, der.octetString(keyId)),
  );

  const tbs = der.sequence(
    der.context(0, der.integer(2)), // v3
    der.integer(serial),
    algorithm,
    name,
    der.sequence(der.time(notBefore), der.time(notAfter)),
    name,
    spki,
    der.context(3, extensions),
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certificate = der.sequence(tbs, algorithm, der.bitString(signature));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: toPem("CERTIFICATE", certificate),
  };
}

// IPs listed in a certificate's subjectAltName.
export function certIPs(x509) {
  return [...String(x509.subjectAltName || "").matchAll(/IP Address:([0-9.]+)/g)].map((m) => m[1]);
}

// Loads <dataDir>/key.pem + cert.pem, regenerating when missing, unreadable, mismatched, expiring
// within a day, or when a required IP is not in the SAN. Required: loopback plus real LAN adapters;
// VM/WSL adapters (new address every boot) are included when generating but do not force a new
// certificate, so the headset does not have to accept a new one after every reboot.
// Returns { key, cert, generated, ips }.
export function ensureCert(dataDir, { ips, required, names } = {}) {
  if (!ips) {
    const all = lanAddresses();
    ips = ["127.0.0.1", ...all.map((a) => a.address)];
    required = required || ["127.0.0.1", ...all.filter((a) => !a.virtual).map((a) => a.address)];
  }
  required = required || ips;
  const keyPath = path.join(dataDir, "key.pem");
  const certPath = path.join(dataDir, "cert.pem");
  try {
    const key = fs.readFileSync(keyPath, "utf8");
    const cert = fs.readFileSync(certPath, "utf8");
    const x509 = new crypto.X509Certificate(cert);
    const valid = Date.parse(x509.validTo) > Date.now() + 24 * 3600 * 1000 && Date.parse(x509.validFrom) <= Date.now();
    const covered = certIPs(x509);
    if (valid && required.every((ip) => covered.includes(ip)) && x509.checkPrivateKey(crypto.createPrivateKey(key))) {
      return { key, cert, generated: false, ips: covered };
    }
  } catch {
    // Missing or unreadable: make a new one below.
  }
  const fresh = generateCert({ names, ips });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, fresh.key, { mode: 0o600 });
  fs.writeFileSync(certPath, fresh.cert);
  return { ...fresh, generated: true, ips: [...new Set(ips)] };
}
