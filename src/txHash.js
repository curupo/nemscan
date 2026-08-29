// NEM transaction hash = keccak-256 of the transaction's binary-serialized
// form (NIS "verifiable entity" layout), *excluding* the signature. Verified
// against real on-chain hashes pulled from a live node (see test/txHash.test.js):
// a v1 transfer with no message, a v1 transfer with a plain-text message, and
// a v2 transfer carrying mosaic attachments.
//
// Only type 257 (Transfer) is implemented. NEM's other transaction types
// (importance transfer, namespace/mosaic provisioning, multisig, ...) each
// have their own body layout; serializing those without real hashes to test
// against risks silently producing wrong hashes, which is worse than not
// showing one. Callers should treat any non-transfer type as unsupported.
import { keccak_256 } from "@noble/hashes/sha3.js";

function hexToBytes(hex) {
  const clean = hex || "";
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

class Writer {
  constructor() {
    this.chunks = [];
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.chunks.push(b);
  }
  u64(v) {
    // Split into low/high 32-bit little-endian words. NEM amounts/fees never
    // approach 2^53, so this stays exact in a JS double.
    this.u32(v % 0x100000000);
    this.u32(Math.floor(v / 0x100000000));
  }
  bytes(b) {
    this.chunks.push(b);
  }
  lengthPrefixedBytes(b) {
    this.u32(b.length);
    this.bytes(b);
  }
  lengthPrefixedAscii(s) {
    this.lengthPrefixedBytes(asciiBytes(s));
  }
  build() {
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

function serializeMosaicId(id) {
  const w = new Writer();
  w.lengthPrefixedAscii(id.namespaceId);
  w.lengthPrefixedAscii(id.name);
  return w.build();
}

function serializeMosaic(m) {
  const w = new Writer();
  w.lengthPrefixedBytes(serializeMosaicId(m.mosaicId));
  w.u64(m.quantity);
  return w.build();
}

function serializeMosaics(mosaics) {
  const w = new Writer();
  w.u32(mosaics.length);
  for (const m of mosaics) w.lengthPrefixedBytes(serializeMosaic(m));
  return w.build();
}

function serializeTransferBody(tx, w) {
  w.lengthPrefixedAscii(tx.recipient);
  w.u64(tx.amount);
  const msg = tx.message || {};
  if (msg.type === 1 || msg.type === 2) {
    const payload = hexToBytes(msg.payload || "");
    if (payload.length === 0) {
      w.u32(0);
    } else {
      w.u32(8 + payload.length);
      w.u32(msg.type);
      w.u32(payload.length);
      w.bytes(payload);
    }
  } else {
    w.u32(0);
  }
  // Version's low byte is the tx version proper; the network id lives in the
  // high byte (e.g. 0x68000001 mainnet v1, 0x98000002 testnet v2).
  const version = tx.version & 0xffffff;
  if (version >= 2 && tx.mosaics && tx.mosaics.length) {
    w.bytes(serializeMosaics(tx.mosaics));
  }
}

// Returns the lowercase hex hash for a raw NIS transfer transaction (type
// 257), or null if `tx` isn't a transfer / is missing required fields.
export function computeTransferTxHash(tx) {
  if (!tx || tx.type !== 257 || !tx.signer || !tx.recipient) return null;
  const w = new Writer();
  w.u32(tx.type);
  w.u32(tx.version);
  w.u32(tx.timeStamp);
  w.lengthPrefixedBytes(hexToBytes(tx.signer));
  w.u64(tx.fee);
  w.u32(tx.deadline);
  serializeTransferBody(tx, w);
  return toHex(keccak_256(w.build()));
}
