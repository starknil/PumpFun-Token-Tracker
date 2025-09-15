require("dotenv").config();
const { PublicKey } = require("@solana/web3.js");

const {
  HELIUS_API_KEY,
} = process.env;

const decodePumpfunData = (base64Data) => {
  const buffer = Buffer.from(base64Data, "base64");
  let offset = 8; // skip discriminator

  function readString() {
    if (offset + 4 > buffer.length) return;
    const len = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + len > buffer.length) return;
    const str = buffer.toString("utf8", offset, offset + len);
    offset += len;
    return str;
  }

  const name = readString();
  const symbol = readString();
  const uri = readString();

  const mint = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
  offset += 32;

  const bondingCurve = new PublicKey(
    buffer.slice(offset, offset + 32)
  ).toBase58();
  offset += 32;

  const creator = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();

  return { name, symbol, uri, mint, bondingCurve, creator };
}


const decodeBuyData = (base64Data) => {
  const buffer = Buffer.from(base64Data, "base64");
  let offset = 8;

  if (buffer.length < offset + 32 + 8 + 8 + 1 + 32 + 32 + 8) return;

  const mint = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
  offset += 32;

  const solAmount = Number(buffer.readBigUInt64LE(offset)) / 1e9;
  offset += 8;

  const tokenAmount = Number(buffer.readBigUInt64LE(offset));
  offset += 8;

  const isBuy = buffer.readUInt8(offset);
  offset += 1;
  if (isBuy !== 1) return null;

  const user = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
  offset += 32;

  const bondingCurve = new PublicKey(
    buffer.slice(offset, offset + 32)
  ).toBase58();
  offset += 32;

  const timestamp = Number(buffer.readBigInt64LE(offset));

  return { mint, solAmount, tokenAmount, user, bondingCurve, timestamp };
};


async function isSuspicious(wallet, tokenMint) {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions/?api-key=${HELIUS_API_KEY}&limit=50`
    );
    const data = await res.json();

    if (!Array.isArray(data)) return "error";

    if (data.length === 0) return true; // not transaction history, suspicious

    // If user has more than 7 transactions, not suspicious
    if (data.length > 7) return false;

    // Track flags in a single pass
    let hasBoughtOtherToken = false;
    let hasSmallTrade = false;

    for (const tx of data) {
      // Skip transactions involving the tracking token
      const involvesTrackingToken = tx.tokenTransfers?.some(t => t.mint === tokenMint);
      if (involvesTrackingToken) continue;

      // Check if user received any token (buy)
      if (!hasBoughtOtherToken) {
        hasBoughtOtherToken = tx.tokenTransfers?.some(t => t.toUserAccount === wallet) ?? false;
      }

      // Check if any native transfer involving the user is < 0.06 SOL
      if (!hasSmallTrade) {
        hasSmallTrade = tx.nativeTransfers?.some(
          n => (n.fromUserAccount === wallet || n.toUserAccount === wallet) && n.amount < 60_000_000
        ) ?? false;
      }

      // Early exit if both flags are true
      if (hasBoughtOtherToken && hasSmallTrade) break;
    }

    // Suspicious if: few transactions & never bought other token OR has a small trade
    return (!hasBoughtOtherToken) || hasSmallTrade;

  } catch (err) {
    console.error("fetchLastTransaction error:", err.message);
    return "error";
  }
}



module.exports = {
    decodePumpfunData,
    decodeBuyData,
    isSuspicious
};