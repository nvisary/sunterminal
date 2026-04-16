"""
Example ML pipeline that reads market data from Redis Streams,
computes features, and publishes signals back.

Requirements:
    pip install redis numpy
"""

import json
import time
from collections import deque

import numpy as np
import redis

REDIS_URL = "redis://localhost:6379"
GROUP_NAME = "python-ml"
CONSUMER_NAME = "ml-pipeline-1"

# Feature buffers
price_buffer: deque[float] = deque(maxlen=100)
volume_buffer: deque[float] = deque(maxlen=100)


def create_consumer_group(r: redis.Redis, stream: str, group: str) -> None:
    try:
        r.xgroup_create(stream, group, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def compute_features(prices: list[float], volumes: list[float]) -> dict:
    """Compute basic trading features from price/volume data."""
    if len(prices) < 20:
        return {}

    arr = np.array(prices)
    vol = np.array(volumes)

    # Simple Moving Averages
    sma_10 = float(np.mean(arr[-10:]))
    sma_20 = float(np.mean(arr[-20:]))

    # Volatility (rolling std)
    returns = np.diff(np.log(arr[-20:]))
    volatility = float(np.std(returns)) if len(returns) > 1 else 0.0

    # Volume-weighted average price
    vwap = float(np.sum(arr[-20:] * vol[-20:]) / np.sum(vol[-20:])) if np.sum(vol[-20:]) > 0 else 0.0

    # Price momentum
    momentum = float((arr[-1] - arr[-10]) / arr[-10]) if arr[-10] != 0 else 0.0

    return {
        "sma_10": round(sma_10, 4),
        "sma_20": round(sma_20, 4),
        "sma_cross": sma_10 > sma_20,  # Golden cross
        "volatility": round(volatility, 6),
        "vwap": round(vwap, 4),
        "momentum": round(momentum, 6),
        "last_price": float(arr[-1]),
        "volume_avg": round(float(np.mean(vol[-20:])), 4),
    }


def generate_signal(features: dict) -> dict | None:
    """Generate a simple trading signal from features."""
    if not features:
        return None

    signal = None

    # SMA crossover signal
    if features.get("sma_cross") and features.get("momentum", 0) > 0.001:
        signal = {
            "type": "BULLISH_CROSS",
            "confidence": min(0.9, 0.5 + abs(features["momentum"]) * 100),
            "reason": f"SMA10 > SMA20, momentum={features['momentum']}",
        }
    elif not features.get("sma_cross") and features.get("momentum", 0) < -0.001:
        signal = {
            "type": "BEARISH_CROSS",
            "confidence": min(0.9, 0.5 + abs(features["momentum"]) * 100),
            "reason": f"SMA10 < SMA20, momentum={features['momentum']}",
        }

    # High volatility warning
    if features.get("volatility", 0) > 0.02:
        signal = signal or {}
        signal["volatility_alert"] = True
        signal["volatility"] = features["volatility"]

    return signal


def run_pipeline(r: redis.Redis, exchange: str, symbol: str) -> None:
    """Main ML pipeline loop."""
    stream_key = f"md:trades:{exchange}:{symbol}"
    features_key = f"ml:features:{symbol}"
    signals_key = f"ml:signals:{symbol}"

    create_consumer_group(r, stream_key, GROUP_NAME)

    print(f"[ml-pipeline] Running on {exchange}:{symbol}")
    print(f"  Reading: {stream_key}")
    print(f"  Publishing features → {features_key}")
    print(f"  Publishing signals → {signals_key}")

    last_feature_time = 0

    while True:
        try:
            messages = r.xreadgroup(
                GROUP_NAME,
                CONSUMER_NAME,
                {stream_key: ">"},
                count=100,
                block=2000,
            )

            if not messages:
                continue

            for stream, entries in messages:
                for msg_id, fields in entries:
                    data = json.loads(fields[b"data"])
                    price_buffer.append(float(data["price"]))
                    volume_buffer.append(float(data["amount"]))
                    r.xack(stream_key, GROUP_NAME, msg_id)

            # Compute and publish features every 1 second
            now = time.time()
            if now - last_feature_time < 1.0:
                continue
            last_feature_time = now

            features = compute_features(list(price_buffer), list(volume_buffer))
            if not features:
                continue

            features["exchange"] = exchange
            features["symbol"] = symbol
            features["timestamp"] = int(now * 1000)

            # Publish features
            r.xadd(
                features_key,
                {"data": json.dumps(features)},
                maxlen=1000,
            )

            # Generate and publish signals
            signal_data = generate_signal(features)
            if signal_data:
                signal_data["exchange"] = exchange
                signal_data["symbol"] = symbol
                signal_data["timestamp"] = int(now * 1000)
                r.xadd(
                    signals_key,
                    {"data": json.dumps(signal_data)},
                    maxlen=1000,
                )
                print(f"  Signal: {signal_data['type']} conf={signal_data.get('confidence', 0):.2f}")

        except KeyboardInterrupt:
            print("\n[ml-pipeline] Stopped.")
            break
        except Exception as e:
            print(f"[ml-pipeline] Error: {e}")
            time.sleep(1)


if __name__ == "__main__":
    import sys

    r = redis.from_url(REDIS_URL, decode_responses=False)

    exchange = sys.argv[1] if len(sys.argv) > 1 else "binance"
    symbol = sys.argv[2] if len(sys.argv) > 2 else "BTC/USDT:USDT"

    run_pipeline(r, exchange, symbol)
