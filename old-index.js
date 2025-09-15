require("dotenv").config();
const { Connection, clusterApiUrl, PublicKey } = require("@solana/web3.js");
const {
  PUMP_FUN_PROGRAM_ID,
  MINIMUM_VALID_BUY_AMOUNT,
  CHECK_UNTIL_STOP,
  MAX_SUSPICIOUS_COUNT,
  HELIUS_API_KEY
} = process.env;


// ✅ WebSocket for logs (real-time)
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
// ✅ HTTP for history / transactions
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  wsEndpoint: WS_URL,
  commitment: "confirmed",
});

module.exports = connection;

const { sendMessage } = require("./bot");
const trackedTokens = {};
console.log("Listening for Pump.fun token creations...");

function decodePumpfunData(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  let offset = 8; // skip discriminator

  function readString() {
    const len = buffer.readUInt32LE(offset);
    offset += 4;
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

function decodeBuyData(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  let offset = 8; // skip discriminator

  if (buffer.length < offset + 32 + 8 + 8 + 1 + 32 + 32 + 8) {
    // not enough bytes to parse full Buy data
    return null;
  }

  const mint = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
  offset += 32;

  const solAmount = Number(buffer.readBigUInt64LE(offset)) / 1e9; // lamports -> SOL
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
}


// Fetch the last transaction of a buyer
async function isSuspiciousBuyer(buyerPubkey) {
  try {
    const history = await connection.getSignaturesForAddress(
      new PublicKey(buyerPubkey),
      { limit: 1 } // only fetch the last transaction
    );

    if (history.length === 0) return true; // zero trades -> suspicious

    const txSig = history[0].signature;
    const tx = await connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.transaction || !tx.meta) return true; // treat as suspicious

    const idx = tx.transaction.message.accountKeys.findIndex(
      (k) => k.toBase58() === buyerPubkey
    );

    if (idx === -1) return true; // suspicious if buyer not in accountKeys

    const lamportsSpent = tx.meta.preBalances[idx] - tx.meta.postBalances[idx];
    const solSpent = lamportsSpent / 1e9;

    return solSpent < 0.1; // suspicious if last trade < 0.1 SOL
  } catch (err) {
    console.error("Error checking buyer history:", err);
    return true; // treat as suspicious on any error
  }
}



connection.onLogs({ mentions: []},
  async (logInfo) => {
    const { signature, logs } = logInfo;

    console.log(signature);
/*
    // --- Handle token creation ---
    if (
      logs.some((log) =>
        log.includes(`Program ${PUMP_FUN_PROGRAM_ID} invoke`)
      ) &&
      logs.some((log) => log === "Program log: Instruction: Create")
    ) {
      const createIndex = logs.findIndex((log) =>
        log.includes("Instruction: Create")
      );
      if (createIndex === -1) return;
      const dataLog = logs
        .slice(createIndex)
        .find((log) => log.startsWith("Program data:"));
      if (!dataLog) return;

      const base64Data = dataLog.split("Program data: ")[1];
      const pumpfunData = decodePumpfunData(base64Data);
      pumpfunData.signature = signature;

      const message = `
🚀 <b>New Pump.fun Token Created!</b>
<b> 📇Name:</b> ${pumpfunData.name}
<b>☯️ Symbol:</b> ${pumpfunData.symbol}
✳️<b> Mint Address:</b> <a href="https://solscan.io/token/${pumpfunData.mint}">${pumpfunData.mint}</a>
<b>Bonding Curve:</b> <a href="https://solscan.io/account/${pumpfunData.bondingCurve}">${pumpfunData.bondingCurve}</a>
<b>🧑🏻‍💻 Creator:</b> <a href="https://solscan.io/account/${pumpfunData.creator}">${pumpfunData.creator}</a>
<b>🌐 Metadata URI:</b> <a href="${pumpfunData.uri}">${pumpfunData.uri}</a>
<b>🔗 Transaction:</b> <i><a href="https://solscan.io/tx/${signature}">${signature}</a></i>
`;
      //await sendMessage(message);

      trackedTokens[pumpfunData.mint] = {
        buyers: new Set(),
        suspiciousCount: 0,
        flagged: false,
        bondingCurve: pumpfunData.bondingCurve,
        signature,
      };
      return;
    }

    // --- Handle buys ---
    if (logs.some((log) => log.includes("Instruction: Buy"))) {
      const buyIndex = logs.findIndex((log) =>
        log.includes("Instruction: Buy")
      );
      if (buyIndex === -1) return;

      const dataLog = logs
        .slice(buyIndex)
        .find((log) => log.startsWith("Program data:"));
      if (!dataLog) return;

      const buyData = decodeBuyData(dataLog.split("Program data: ")[1]);
      if (!buyData) return;

      // Only track buys for tokens we are tracking
      const token = trackedTokens[buyData.mint];

      if (!token || token.flagged) return;

      if (token.buyers.size >= 40) return; // already tracked first 40
      if (token.buyers.has(buyData.user)) return; // already seen

      token.buyers.add(buyData.user);

      if (await isSuspiciousBuyer(buyData.user)) token.suspiciousCount++;

      if (token.suspiciousCount >= 5 && !token.flagged) {
        token.flagged = true;
        const alertMsg = `⚠️ Suspicious Pump.fun Token Detected!\nSuspicious buyers: ${token.suspiciousCount}\nMint: <i>${buyData.mint}</i>`;
        console.log(alertMsg);
        await sendMessage(alertMsg);
      }
    }
      */
  },
  "confirmed"
);