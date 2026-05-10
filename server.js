const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let expoPushToken = null;

const coins = {
  BTC: {
    id: "bitcoin",
    name: "Bitcoin",
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
  },
  ETH: {
    id: "ethereum",
    name: "Ethereum",
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
  },
};

const alertHistory = [];
const lastAlertTimes = {};

function calculateChange(current, old) {
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

function canSendAlert(key) {
  const now = Date.now();
  const last = lastAlertTimes[key];

  if (!last) return true;

  return now - last >= 30 * 60 * 1000;
}

async function sendPush(message) {
  if (!expoPushToken) {
    console.log("Brak tokenu push:", message);
    return;
  }

  try {
    await axios.post("https://exp.host/--/api/v2/push/send", {
      to: expoPushToken,
      sound: "default",
      title: "Crypto Radar",
      body: message,
    });

    console.log("Wysłano push:", message);
  } catch (error) {
    console.log("Błąd push:", error.message);
  }
}

function rememberAlert(key, message) {
  if (!canSendAlert(key)) return;

  lastAlertTimes[key] = Date.now();

  const time = new Date().toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  });

  alertHistory.unshift(`${time} — ${message}`);

  if (alertHistory.length > 20) {
    alertHistory.pop();
  }

  sendPush(message);
}

async function checkMarket() {
  try {
    console.log("Sprawdzam rynek...");

    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/markets",
      {
        params: {
          vs_currency: "usd",
          ids: "bitcoin,ethereum",
          price_change_percentage: "24h",
        },
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

      if (coin.history.length > 30) coin.history.shift();
      if (coin.volumeHistory.length > 30) coin.volumeHistory.shift();

      coin.change15m = null;
      coin.change30m = null;
      coin.rsi = calculateRSI(coin.history);
      coin.alert = null;
      coin.strongAlert = null;
      coin.tradeSignal = null;
      coin.volumeAlert = null;

      if (coin.history.length >= 15) {
        const price15mAgo = coin.history[coin.history.length - 15];
        coin.change15m = calculateChange(price, price15mAgo);

        if (coin.change15m >= 2.5) {
          coin.alert = `🚀 ${symbol} rośnie +2.5% / 15 min — możliwy impuls wzrostowy`;
          rememberAlert(`${symbol}_UP_15`, coin.alert);
        }

        if (coin.change15m <= -4) {
          coin.alert = `🔻 ${symbol} spada -4% / 15 min — możliwa panika lub okazja`;
          rememberAlert(`${symbol}_DOWN_15`, coin.alert);
        }
      }

      if (coin.history.length >= 30) {
        const price30mAgo = coin.history[coin.history.length - 30];
        coin.change30m = calculateChange(price, price30mAgo);

        if (coin.change30m >= 5) {
          coin.strongAlert = `🚨 SILNY WZROST ${symbol}: +5% / 30 min — sprawdź natychmiast`;
          rememberAlert(`${symbol}_STRONG_UP_30`, coin.strongAlert);
        }

        if (coin.change30m <= -6) {
          coin.strongAlert = `🚨 SILNY SPADEK ${symbol}: -6% / 30 min — sprawdź natychmiast`;
          rememberAlert(`${symbol}_STRONG_DOWN_30`, coin.strongAlert);
        }
      }

      if (coin.volumeHistory.length >= 15) {
        const volume15mAgo = coin.volumeHistory[coin.volumeHistory.length - 15];

        if (volume15mAgo > 0 && volume >= volume15mAgo * 2) {
          coin.volumeAlert = `📈 ${symbol}: wolumen x2 względem ostatnich 15 min — coś się szykuje`;
          rememberAlert(`${symbol}_VOLUME_X2`, coin.volumeAlert);
        }
      }

      if (coin.rsi !== null && coin.change15m !== null) {
        if (coin.rsi < 30 && coin.change15m <= -2) {
          coin.tradeSignal = `🟢 MOŻLIWY BUY ${symbol}: RSI < 30 i rynek mocno spadł — sprawdź odbicie`;
          rememberAlert(`${symbol}_BUY_SIGNAL`, coin.tradeSignal);
        }

        if (coin.rsi > 70 && coin.change15m >= 2) {
          coin.tradeSignal = `🔴 MOŻLIWY SELL ${symbol}: RSI > 70 i rynek mocno urósł — możliwe przegrzanie`;
          rememberAlert(`${symbol}_SELL_SIGNAL`, coin.tradeSignal);
        }
      }

      console.log(
        symbol,
        "price:",
        coin.price,
        "15m:",
        coin.change15m,
        "30m:",
        coin.change30m,
        "RSI:",
        coin.rsi
      );
    }
  } catch (error) {
    console.log("Błąd sprawdzania rynku:", error.message);
  }
}

app.post("/register-token", (req, res) => {
  const { token } = req.body;

  expoPushToken = token;

  console.log("Zapisano push token:", expoPushToken);

  res.json({
    success: true,
    token: expoPushToken,
  });
});

app.get("/status", (req, res) => {
  res.json({
    coins,
    alertHistory,
    pushTokenSaved: !!expoPushToken,
  });
});

app.get("/", (req, res) => {
  res.send("Crypto Radar backend działa");
});

app.listen(PORT, () => {
  console.log(`Crypto Radar backend działa na porcie ${PORT}`);

  checkMarket();

  setInterval(() => {
    checkMarket();
  }, 60 * 1000);
});