import { keccak_256 } from "@noble/hashes/sha3.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { NEM_EPOCH_MS, NETWORKS, KNOWN_EXCHANGE_NAMES } from "./constants.js";
import { currentNetwork } from "./context.js";

export function nemDate(ts) {
  return new Date(NEM_EPOCH_MS + ts * 1000);
}

export function dateKeyFromTs(ts) {
  return nemDate(ts).toISOString().slice(0, 10);
}

export function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function truncKey(k) {
  return k ? `${k.slice(0, 8)}…${k.slice(-4)}` : "—";
}

export function truncHash(h) {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—";
}

const _addrCache = new Map();
const _B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function _b32(buf) {
  let out = "",
    bits = 0,
    val = 0;
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += _B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += _B32[(val << (5 - bits)) & 31];
  return out;
}

export function pubKeyToAddress(hex, net = 0x68) {
  if (!hex) return null;
  const cacheKey = `${net}:${hex}`;
  if (_addrCache.has(cacheKey)) return _addrCache.get(cacheKey);
  const s1 = keccak_256(Buffer.from(hex, "hex"));
  const s2 = ripemd160(s1);
  const s3 = new Uint8Array(21);
  s3[0] = net;
  s3.set(s2, 1);
  const cs = keccak_256(s3);
  const raw = new Uint8Array(25);
  raw.set(s3);
  raw.set(cs.subarray(0, 4), 21);
  const addr = _b32(raw);
  _addrCache.set(cacheKey, addr);
  return addr;
}

// Resolves the correct NIS1 address network byte (mainnet 0x68 / testnet
// 0x98) for the request currently being rendered. Moved here from html.js
// so cache.js can also resolve tx.signer addresses when extracting
// exchange inflow/outflow from cached block data.
export function addrFromPubKey(hex) {
  return pubKeyToAddress(hex, NETWORKS[currentNetwork()].addressNetworkByte);
}

// Case-insensitive substring match of a richlist `info` label against
// KNOWN_EXCHANGE_NAMES. Returns the matched canonical name, or null if the
// label doesn't name a known exchange (or is empty).
export function matchExchangeName(info) {
  if (!info) return null;
  const lower = info.toLowerCase();
  return KNOWN_EXCHANGE_NAMES.find((name) => lower.includes(name.toLowerCase())) ?? null;
}

export function xem(v) {
  if (!v) return "0.00";
  return (v / 1e6).toLocaleString("en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDiff(d) {
  return d ? `${(d / 1e12).toFixed(3)}T` : "—";
}

export function formatImportance(v) {
  return v ? (v * 100).toFixed(6) + "%" : "0.000000%";
}

export function esc(s) {
  return String(s).replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c],
  );
}

export function decodeMsg(msg) {
  if (!msg?.payload) return "";
  if (msg.type === 2) return "[Encrypted]";
  try {
    return esc(Buffer.from(msg.payload, "hex").toString("utf8"));
  } catch {
    return "";
  }
}

// Parses "namespace:mosaic" (e.g. from the /mosaictransfer page's search
// form, ?q=dim:coin) into { ns, m }, or null if it doesn't look like a
// mosaic ID. `String(q || "")` guards against Express handing back an array
// for a repeated query param (?q=a&q=b) — .trim() would throw on an array.
export function parseMosaicIdQuery(q) {
  const raw = String(q || "").trim().toLowerCase();
  const idx = raw.indexOf(":");
  if (idx < 1 || idx === raw.length - 1) return null;
  return { ns: raw.slice(0, idx).trim(), m: raw.slice(idx + 1).trim() };
}

// Reads ns/m query params directly into a { ns, m } filter (used by the
// /api/mosaictransfer* routes, which receive them pre-split rather than as
// a single "ns:m" string). Returns { ns: null, m: null } unless both are
// present, since a partial filter has no well-defined meaning here.
export function mosaicFilterFromQuery(query) {
  const ns = String(query.ns || "").trim().toLowerCase() || null;
  const m = String(query.m || "").trim().toLowerCase() || null;
  return ns && m ? { ns, m } : { ns: null, m: null };
}
