const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let expoPushToken = null;

const coins = {
  BTC: createCoin("bitcoin", "Bitcoin"),
  ETH: createCoin("ethereum", "Ethereum"),
};

const alertHistory = [];
const lastAlertTimes = {};

function createCoin(id, name) {
  return {
    id,
    name,
    price: null,
    change24h: null,
    volume: null,
    history: [],
    volumeHistory: [],
    rsi: null,
    change15m: null,
    change30m: null,
    alert: null,
    strongAlert: null,
    tradeSignal: null,
    volumeAlert: null,
    score: 0,
    recommendation: "OBSERWUJ",
  };
}

function calculateChange(current, old) {
  if (!old || old === 0) return null;
  return ((current - old) / old) * 100;
}

function calculateRSI(history, period = 14) {
  if (history.length < period + 1) return null;

  const prices = history.slice(-(period + 1));
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function getCooldownMs(type) {
  if (type.includes("CRITICAL")) return 0;
  if (type.includes("STRONG")) return 3 * 60 * 60 * 1000;
  if (type.includes("BUY") || type.includes("SELL")) return 2 * 60 * 60 * 1000;
  return 45 * 60 * 1000;
}

function canSendAlert(key, type) {
  const now = Date.now();
  const last = lastAlertTimes[key];

  if (!last) return true;

  return now - last >= getCooldownMs(type);
}

async function sendPush(title, message) {
  if (!expoPushToken) {
    console.log("Brak tokenu push:", message);
    return;
  }

  try {
    await axios.post("https://exp.host/--/api/v2/push/send", {
      to: expoPushToken,
      sound: "default",
      title,
      body: message,
      priority: "high",
    });

    console.log("Wysłano push:", message);
  } catch (error) {
    console.log("Błąd push:", error.message);
  }
}

function rememberAlert(symbol, type, message) {
  const key = `${symbol}_${type}`;

  if (!canSendAlert(key, type)) return;

  lastAlertTimes[key] = Date.now();

  const time = new Date().toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  alertHistory.unshift(`${time} — ${message}`);

  if (alertHistory.length > 40) {
    alertHistory.pop();
  }

  sendPush("CryptoRadar", message);
}

function analyzeCoin(symbol, coin) {
  let score = 0;
  let reasons = [];

  const rsi = coin.rsi;
  const change15 = coin.change15m;
  const change30 = coin.change30m;

  coin.alert = null;
  coin.strongAlert = null;
  coin.tradeSignal = null;
  coin.volumeAlert = null;
  coin.recommendation = "OBSERWUJ";

  const volumeNow = coin.volumeHistory.at(-1);
  const volume15Ago =
    coin.volumeHistory.length >= 15
      ? coin.volumeHistory[coin.volumeHistory.length - 15]
      : null;

  const volumeSpike =
    volumeNow && volume15Ago && volume15Ago > 0
      ? volumeNow >= volume15Ago * 2
      : false;

  if (volumeSpike) {
    score += 20;
    coin.volumeAlert = `📈 ${symbol}: wolumen x2 względem ostatnich 15 min`;
    reasons.push("silny wolumen");
    rememberAlert(symbol, "VOLUME", coin.volumeAlert);
  }

  if (change15 !== null) {
    if (change15 >= 2.5) {
      score += 15;
      coin.alert = `🚀 ${symbol}: wzrost ${change15.toFixed(2)}% / 15 min`;
      reasons.push("szybki wzrost");
    }

    if (change15 <= -4) {
      score += 18;
      coin.alert = `🔻 ${symbol}: spadek ${change15.toFixed(2)}% / 15 min`;
      reasons.push("szybki spadek");
    }
  }

  if (change30 !== null) {
    if (change30 >= 5) {
      score += 25;
      coin.strongAlert = `🚨 SILNY WZROST ${symbol}: ${change30.toFixed(
        2
      )}% / 30 min`;
      reasons.push("silny wzrost 30m");
      rememberAlert(symbol, "STRONG_UP", coin.strongAlert);
    }

    if (change30 <= -6) {
      score += 30;
      coin.strongAlert = `🚨 SILNY SPADEK ${symbol}: ${change30.toFixed(
        2
      )}% / 30 min`;
      reasons.push("silny spadek 30m");
      rememberAlert(symbol, "STRONG_DOWN", coin.strongAlert);
    }
  }

  if (rsi !== null) {
    if (rsi < 30) {
      score += 20;
      reasons.push("RSI wyprzedanie");
    }

    if (rsi > 70) {
      score += 20;
      reasons.push("RSI wykupienie");
    }
  }

  const buySignal =
    rsi !== null &&
    change15 !== null &&
    rsi < 32 &&
    change15 <= -1.5 &&
    (volumeSpike || score >= 45);

  const sellSignal =
    rsi !== null &&
    change15 !== null &&
    rsi > 70 &&
    change15 >= 1.5 &&
    (volumeSpike || score >= 45);

  const criticalBuy =
    change30 !== null &&
    change30 <= -6 &&
    volumeSpike &&
    rsi !== null &&
    rsi < 35;

  const criticalSell =
    change30 !== null &&
    change30 >= 5 &&
    volumeSpike &&
    rsi !== null &&
    rsi > 70;

  if (criticalBuy) {
    coin.recommendation = "KRYTYCZNY BUY";
    coin.tradeSignal = `🟢 KRYTYCZNY BUY ${symbol}: silny spadek + wolumen + RSI. Sprawdź wejście natychmiast.`;
    rememberAlert(symbol, "CRITICAL_BUY", coin.tradeSignal);
  } else if (criticalSell) {
    coin.recommendation = "KRYTYCZNY SELL";
    coin.tradeSignal = `🔴 KRYTYCZNY SELL ${symbol}: silny wzrost + wolumen + RSI. Możliwe przegrzanie rynku.`;
    rememberAlert(symbol, "CRITICAL_SELL", coin.tradeSignal);
  } else if (buySignal) {
    coin.recommendation = "MOŻLIWY BUY";
    coin.tradeSignal = `🟢 MOŻLIWY BUY ${symbol}: ${reasons.join(
      ", "
    )}. Sprawdź wykres przed decyzją.`;
    rememberAlert(symbol, "BUY", coin.tradeSignal);
  } else if (sellSignal) {
    coin.recommendation = "MOŻLIWY SELL";
    coin.tradeSignal = `🔴 MOŻLIWY SELL ${symbol}: ${reasons.join(
      ", "
    )}. Możliwe przegrzanie.`;
    rememberAlert(symbol, "SELL", coin.tradeSignal);
  } else if (coin.strongAlert) {
    coin.recommendation = "SILNY RUCH";
  } else if (coin.alert || coin.volumeAlert) {
    coin.recommendation = "UWAGA";
  }

  coin.score = Math.min(score, 100);
}

async function checkMarket() {
  console.log("Sprawdzam rynek...");

  const response = await axios.get(
    "https://api.coingecko.com/api/v3/coins/markets",
    {
      params: {
        vs_currency: "usd",
        ids: "bitcoin,ethereum",
        price_change_percentage: "24h",
      },
      timeout: 15000,
    }
  );

  for (const item of response.data) {
    const symbol = item.id === "bitcoin" ? "BTC" : "ETH";
    const coin = coins[symbol];

    const price = item.current_price;
    const volume = item.total_volume;

    coin.price = price;
    coin.change24h = item.price_change_percentage_24h;
    coin.volume = volume;

    coin.history.push(price);
    coin.volumeHistory.push(volume);

    if (coin.history.length > 90) coin.history.shift();
    if (coin.volumeHistory.length > 90) coin.volumeHistory.shift();

    coin.change15m = null;
    coin.change30m = null;

    if (coin.history.length >= 15) {
      const price15mAgo = coin.history[coin.history.length - 15];
      coin.change15m = calculateChange(price, price15mAgo);
    }

    if (coin.history.length >= 30) {
      const price30mAgo = coin.history[coin.history.length - 30];
      coin.change30m = calculateChange(price, price30mAgo);
    }

    coin.rsi = calculateRSI(coin.history);

    analyzeCoin(symbol, coin);

    console.log(
      symbol,
      "price:",
      coin.price,
      "15m:",
      coin.change15m,
      "30m:",
      coin.change30m,
      "RSI:",
      coin.rsi,
      "score:",
      coin.score,
      "recommendation:",
      coin.recommendation
    );
  }

  return coins;
}

app.post("/register-token", (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: "Brak tokenu",
    });
  }

  expoPushToken = token;

  console.log("Zapisano push token:", expoPushToken);

  res.json({
    success: true,
    tokenSaved: true,
  });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    coins,
    alertHistory,
    pushTokenSaved: !!expoPushToken,
    updatedAt: new Date().toISOString(),
  });
});

app.get("/check-now", async (req, res) => {
  try {
    await checkMarket();

    res.json({
      ok: true,
      message: "Radar sprawdził rynek",
      coins,
      alertHistory,
      pushTokenSaved: !!expoPushToken,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Błąd /check-now:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.send("CryptoRadar backend działa");
});

app.listen(PORT, () => {
  console.log(`CryptoRadar backend działa na porcie ${PORT}`);

  checkMarket().catch((error) => {
    console.log("Błąd pierwszego sprawdzenia rynku:", error.message);
  });

  setInterval(() => {
    checkMarket().catch((error) => {
      console.log("Błąd cyklicznego sprawdzania rynku:", error.message);
    });
  }, 60 * 1000);
});