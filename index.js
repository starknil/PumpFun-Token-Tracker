require("dotenv").config();
const WebSocket = require("ws");
const { PublicKey } = require("@solana/web3.js");
const fetch = require("node-fetch");
const { sendMessage } = require("./bot");

const {
  PUMP_FUN_PROGRAM_ID,
  MINIMUM_VALID_BUY_AMOUNT = "0.01",
  CHECK_UNTIL_STOP = "40",
  MAX_SUSPICIOUS_COUNT = "5",
  HELIUS_API_KEY,
} = process.env;

const { decodePumpfunData, decodeBuyData, isSuspicious } = require("./utils");

const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const ws = new WebSocket(WS_URL);

const trackedTokens = {};

console.log("Connecting to Helius WebSocket...");

ws.on("open", () => {
  console.log("Connected. Subscribing to Pump.fun program logs...");
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMP_FUN_PROGRAM_ID] },
        { commitment: "confirmed", encoding: "base64" },
      ],
    })
  );
});

ws.on("message", async (msg) => {
  try {
    const data = JSON.parse(msg);

    if (!data.params?.result?.value?.logs) return;

    const { logs, signature } = data.params.result.value;

    // Token creation
    if (logs.some((l) => l.includes("Instruction: Create"))) {
      const createIndex = logs.findIndex((l) =>
        l.includes("Instruction: Create")
      );
      const dataLog = logs
        .slice(createIndex)
        .find((l) => l.startsWith("Program data:"));
      if (!dataLog) return;
      const base64Data = dataLog.split("Program data: ")[1];
      const pumpfunData = decodePumpfunData(base64Data);
      pumpfunData.signature = signature;
      pumpfunData.validated = false;

      trackedTokens[pumpfunData.mint] = {
        buyers: new Set(),
        suspiciousCount: 0,
        suspiciousBuyers: [],
        flagged: false,
        bondingCurve: pumpfunData.bondingCurve,
        mint: pumpfunData.mint,
        signature,
      };
      //console.log(`🚀 New token created: ${pumpfunData.mint}`);
    }

    // Buy event
    if (logs.some((l) => l.includes("Instruction: Buy"))) {
      const buyIndex = logs.findIndex((l) => l.includes("Instruction: Buy"));

      const dataLog = logs
        .slice(buyIndex)
        .find((l) => l.startsWith("Program data:"));

      if (!dataLog) return;

      const buyData = decodeBuyData(dataLog.split("Program data: ")[1]);
      if (!buyData) return;

      const token = trackedTokens[buyData.mint];
      if (!token || token.flagged || token.validated) return;
 
      if (buyData.solAmount < 0.1) return; // ignore tiny buys
      if (token.buyers.size >= 20) return; // first 20 buys only
      if (token.buyers.has(buyData.user)) return; // unique addresses only

      token.buyers.add(buyData.user);

      const suspicious = await isSuspicious(buyData.user, buyData.mint);

      if (suspicious == "error") return;

      if (suspicious){
        token.suspiciousCount++
        token.suspiciousBuyers.push(buyData);
      };

      // Flag if >= MAX_SUSPICIOUS_COUNT
      if (token.suspiciousCount >= 4 && !token.flagged) {
        token.flagged = true;
        console.log(
          `⚠️ Suspicious Pump.fun Token Detected! Suspicious buyers: ${token.suspiciousCount} Mint: ${token.mint}`
        );

        console.log(token.suspiciousBuyers);

        await sendMessage(`
<b>⚠️ Suspicious Pump.fun Token Detected!

⛔️ Suspicious buyers:</b> ${token.suspiciousCount}
- ${ token.suspiciousBuyers.map(b => `${b.user}`).join('\n- ') }

✳️ <b>Mint Address:</b> <a href="https://solscan.io/token/${token.mint}">${token.mint}</a>

<i>✍️ Out of the first ${token.buyers.size} buyers, ${token.suspiciousCount} buys are consider suspicious after critical analysis.</i>
`);
      } else if (!token.validated && token.buyers.size === 20) {
        token.validated = true;
        console.log(`✅ Valid Token Detected! Mint: ${token.mint}`)
        console.log(token.suspiciousBuyers);
        await sendMessage(`
✅ <b>Token is valid after first 20 buy!

✳️ Token Address:</b> <a href="https://solscan.io/token/${token.mint}">${token.mint}</a>
`);
      }
    }
  } catch (err) {
    console.error("Error processing WS message:", err);
  }
});

ws.on("close", () => console.log("WS connection closed."));
ws.on("error", (err) => console.error("WS error:", err));
