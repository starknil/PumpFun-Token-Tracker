require("dotenv").config();
const WebSocket = require("ws");
const { PublicKey } = require("@solana/web3.js");
const fetch = require("node-fetch");
const { sendMessage } = require("./bot");


const {
  PUMP_FUN_PROGRAM_ID,
  CHECK_UNTIL_STOP,
  MAX_SUSPICIOUS_COUNT,
  MARKET_CAP_TRACK,
  HELIUS_API_KEY,
  SYNDICA_API_KEY
} = process.env;

const {
  decodePumpfunData,
  decodeBuyData,
  isSuspiciousHelius,
  fetchTokenMarketCap,
  isSuspiciousSyndica,
} = require("./utils");


//let WS_URL = `wss://vmainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const WS_URL = `wss://solana-mainnet.api.syndica.io/api-key/${SYNDICA_API_KEY}`;


const ws = new WebSocket(WS_URL);

const trackedTokens = {};
let solDetails = {
  solPrice: 0,
  lastFetched: null,
};

console.log("Connecting to Syndica WebSocket...");

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
        uri: pumpfunData.uri,
        signature,
        validated: false,
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

      const buyData = decodeBuyData(
        dataLog.split("Program data: ")[1],
        signature
      );

      if (!buyData) return;

      const token = trackedTokens[buyData.mint];
      if (!token || token.validated) return;


      if (token.flagged && !token.marketCapReached) {

        if (buyData.solAmount < 0.01) return;

        if (token.lastTimeMcCheck && Date.now() - token.lastTimeMcCheck < 2000)
          return;

        if (token.tokenTotalSupply === null) {
          const mcc = await fetchTokenMarketCap(token.mint);
          if (!mcc) return;
          token.tokenTotalSupply = mcc.supply;
          token.decimals = mcc.decimals;
        }

        const tokenAmount = buyData.tokenAmount / 10 ** token.decimals;
        const totalSupply = token.tokenTotalSupply / 10 ** token.decimals;
        const tokenPrice = buyData.solAmount / tokenAmount;
        const marketCap = totalSupply * tokenPrice;

        if (
          !solDetails.lastFetched ||
          Date.now() - solDetails.lastFetched > 30000
        ) {
          const response = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
          );
          const data = await response.json();
          solDetails = { solPrice: data.solana?.usd, lastFetched: Date.now() };
        }

        const tokenPriceUSD = tokenPrice * solDetails.solPrice;
        const marketCapUSD = marketCap * solDetails.solPrice;
        token.lastTimeMcCheck = Date.now();


        //console.log(token.mint, tokenPriceUSD.toFixed(10), marketCapUSD.toFixed(2));

        if (marketCapUSD >= MARKET_CAP_TRACK) {
          token.marketCapReached = true;
          if (!token.notified) {
            token.notified = true;
            const msg = `
🚀 <b>Token Market Cap Alert!

✳️ Mint Address:</b> <a href="https://solscan.io/token/${token.mint}">${
              token.mint
            }</a>
💰 <b>Token Price:</b> ${tokenPrice.toFixed(10)} SOL (~$${tokenPriceUSD.toFixed(
              2
            )} USD)
📊 <b>Market Cap:</b> ${marketCap.toFixed(6)} SOL (~$${marketCapUSD.toFixed(
              2
            )} USD)

⚠️ This token has reached the target market cap threshold of ${Number(MARKET_CAP_TRACK).toLocaleString()}!
`;
            await sendMessage("channel", msg);
            await sendMessage("group", token.mint);

            console.log(`
🚀 [MARKET CAP ALERT] Token reached target!

Mint: ${token.mint}
Price: ${tokenPrice.toFixed(10)} SOL (~$${tokenPriceUSD.toFixed(2)})
Market Cap: ${marketCap.toFixed(6)} SOL (~$${marketCapUSD.toFixed(2)})
---------------------------
`);
          }
        }
      }

      if (token.buyers.has(buyData.user)) return; // unique addresses only
      let buyerSize = token.buyers.size;

      let minBuy = buyerSize === 0 ? 0 : 0.16;

      if (buyData.solAmount < minBuy) return;

      token.buyers.add(buyData.user);
      buyerSize = token.buyers.size;

      const suspicious = await isSuspiciousSyndica(
        buyData.user,
        buyData.mint,
        buyerSize
      );

      if (suspicious == "error") return;

      if (suspicious) {
        token.suspiciousCount++;
        token.suspiciousBuyers.push(buyData);
      }

      // Flag if >= MAX_SUSPICIOUS_COUNT
      if (token.suspiciousCount >= MAX_SUSPICIOUS_COUNT && !token.flagged) {
        token.flagged = true;
        token.tokenTotalSupply = null;
        token.marketCapReached = false;
        token.lastTimeMcCheck = null;
        if (!token.uri) return console.log("No valid metadata uri");
        const r = await fetch(token.uri);
        const metadata = await r.json();
        const { twitter } = metadata || {};
        console.log(twitter);
        if (!twitter || !twitter.includes("//") || !twitter.split("//")[1].startsWith("x.com")) {
          return console.log("No valid twitter info");
        };
        await sendMessage('channel', `
<b>⚠️ Suspicious Pump.fun Token Detected!

⛔️ Suspicious buyers:</b> ${token.suspiciousCount}
- ${token.suspiciousBuyers
          .map(
            (b) =>
              `<a href="https://solscan.io/account/${b.user}">${b.user}</a> bought ${b.tokenAmount.toLocaleString()}(RAW) tokens (${b.solAmount} SOL)`
          )
          .join("\n- ")}

✳️ <b>Mint Address:</b> <a href="https://solscan.io/token/${token.mint}">${
          token.mint
        }</a>
        
🫆 <b>Twitter:</b> ${twitter}

<i>✍️ Out of the first ${token.buyers.size} buyers, ${
          token.suspiciousCount
        } buys are consider suspicious after critical analysis.

🚀 MarketCap Tracking started </i>
`);
      } else if (
        !token.validated &&
        !token.flagged &&
        ((buyerSize === 1 && token.suspiciousCount === 0) ||
          token.buyers.size == CHECK_UNTIL_STOP)
      ){
        token.validated = true;
        delete trackedTokens[token.mint];
      }
    };
  } catch (err) {
    console.error("Error processing WS message:", err);
  }
});

ws.on("close", () => console.log("WS connection closed."));
ws.on("error", (err) => console.error("WS error:", err));


process.on("SIGINT", () => {
  console.log("Closing WebSocket before shutdown...");
  ws.close();
  process.exit();
});

process.on("SIGTERM", () => {
  console.log("Closing WebSocket before shutdown...");
  ws.close();
  process.exit();
});