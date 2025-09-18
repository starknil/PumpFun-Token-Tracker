require("dotenv").config();
const { PublicKey } = require("@solana/web3.js");

const { HELIUS_API_KEY, SYNDICA_API_KEY } = process.env;

const SYNDICA_RPC = `https://solana-mainnet.api.syndica.io/api-key/${SYNDICA_API_KEY}`;

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
};

const decodeBuyData = (base64Data, signature) => {
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

  return {
    mint,
    solAmount,
    tokenAmount,
    user,
    bondingCurve,
    signature,
    timestamp,
  };
};

async function isSuspiciousHelius(wallet, tokenMint, c) {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions/?api-key=${HELIUS_API_KEY}&limit=4`
    );
    const data = await res.json();

    if (!Array.isArray(data)) return "error";

    if (data.length === 0) return true; // not transaction history, suspicious

    // If user has more than 3 transactions, not suspicious
    if (data.length > 3) return false;

    // Track flags in a single pass
    let hasBoughtOtherToken = false;
    let hasSmallTrade = false;

    for (const tx of data) {
      // Skip transactions involving the tracking token
      const involvesTrackingToken = tx.tokenTransfers?.some(
        (t) => t.mint === tokenMint
      );
      if (involvesTrackingToken) continue;

      // Check if user received any token (buy)
      if (!hasBoughtOtherToken) {
        hasBoughtOtherToken =
          tx.tokenTransfers?.some((t) => t.toUserAccount === wallet) ?? false;
      }

      // Check if any native transfer involving the user is < 0.06 SOL
      if (!hasSmallTrade) {
        hasSmallTrade =
          tx.nativeTransfers?.some(
            (n) =>
              (n.fromUserAccount === wallet || n.toUserAccount === wallet) &&
              n.amount < 60_000_000
          ) ?? false;
      }

      // Early exit if both flags are true
      if (hasBoughtOtherToken && hasSmallTrade) break;
    }

    // Suspicious if: few transactions & never bought other token OR has a small trade
    return !hasBoughtOtherToken || hasSmallTrade;
  } catch (err) {
    console.error("fetchLastTransaction error:", err.message);
    return "error";
  }
}


async function isSuspiciousSyndica(wallet, tokenMint, c) {
  try {
    // Step 1: fetch signatures
    const sigRes = await fetch(SYNDICA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [wallet, { limit: 4 }],
      }),
    });

    const sigData = await sigRes.json();

    if (!Array.isArray(sigData.result)) return "error";

    if (sigData.result.length === 0) return true; // not transaction history, suspicious

    // If user has more than 3 transactions, not suspicious
    if (sigData.result.length > 3) return false;

    const signatures = sigData.result.map((s) => s.signature);

    // Step 2: fetch full transactions
    const txRes = await fetch(SYNDICA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        signatures.map((sig, i) => ({
          jsonrpc: "2.0",
          id: i,
          method: "getTransaction",
          params: [sig, { commitment: "confirmed" }],
        }))
      ),
    });

    const data = await txRes.json();

    // Track flags in a single pass
    let hasBoughtOtherToken = false;
    let hasSmallTrade = false;

    for (const rawtx of data) {
      const tx = rawtx.result;
      if (!tx || !tx.meta) continue;

      const { meta, transaction } = tx;
      const accountKeys = transaction.message.accountKeys.map((k) =>
        typeof k === "string" ? k : k.pubkey
      );

      // --- 1. Skip txs involving the tracking mint
      const preMints = (meta.preTokenBalances ?? []).map((b) => b.mint);
      const postMints = (meta.postTokenBalances ?? []).map((b) => b.mint);
      if ([...preMints, ...postMints].includes(tokenMint)) continue;

      // --- 2. Did wallet receive any other token?
      if (!hasBoughtOtherToken) {
        for (const bal of meta.postTokenBalances ?? []) {
          if (bal.owner === wallet && bal.mint !== tokenMint) {
            const pre = meta.preTokenBalances?.find(
              (p) => p.accountIndex === bal.accountIndex && p.mint === bal.mint
            );
            const preAmount = BigInt(pre?.uiTokenAmount?.amount ?? "0");
            const postAmount = BigInt(bal.uiTokenAmount?.amount ?? "0");
            if (postAmount > preAmount) {
              hasBoughtOtherToken = true;
              break;
            }
          }
        }
      }

      // --- 3. Small SOL trade?
      if (!hasSmallTrade) {
        const pre = meta.preBalances ?? [];
        const post = meta.postBalances ?? [];
        for (let i = 0; i < pre.length; i++) {
          const diff = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
          if (diff !== 0n && accountKeys[i] === wallet) {
            if (diff < 60_000_000n && diff > -60_000_000n) {
              hasSmallTrade = true;
              break;
            }
          }
        }
      }
      // Early exit
      if (hasBoughtOtherToken && hasSmallTrade) break;
    }
    // Suspicious if: few transactions & never bought other token OR has a small trade
    return !hasBoughtOtherToken || hasSmallTrade;

  } catch (err) {
    console.error("fetchLastTransaction error:", err.message);
    return "error";
  }
}


async function fetchTokenMarketCap(tokenMint) {
  try {
    const body = {
      jsonrpc: "2.0",
      id: "1",
      method: "getAccountInfo",
      params: [tokenMint, { encoding: "base64"}],
    };

    const response = await fetch(
      SYNDICA_RPC,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    if (!data.result?.value) return null;

    const buffer = Buffer.from(data.result.value.data[0], "base64");

    const supply = Number(buffer.readBigUInt64LE(36));
    const decimals = buffer[44];

    const token_info = {
      supply,
      decimals
    }

    console.log(tokenMint, token_info);

    return token_info;

  } catch (err) {
    console.error("Error fetching market cap from Helius:", err.message);
    return null;
  }
}

module.exports = {
  decodePumpfunData,
  decodeBuyData,
  isSuspiciousHelius,
  isSuspiciousSyndica,
  fetchTokenMarketCap,
};