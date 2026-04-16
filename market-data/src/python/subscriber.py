"""
Python subscriber for Market Data Layer.
Reads from Redis Streams (md:*) and can publish to ml:*.

Requirements:
    pip install redis
"""

import json
import time
import redis

REDIS_URL = "redis://localhost:6379"
GROUP_NAME = "python-ml"
CONSUMER_NAME = "ml-worker-1"


def create_consumer_group(r: redis.Redis, stream: str, group: str) -> None:
    """Create consumer group if it doesn't exist."""
    try:
        r.xgroup_create(stream, group, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def subscribe_trades(r: redis.Redis, exchange: str, symbol: str) -> None:
    """Subscribe to trade stream for a specific exchange:symbol pair."""
    stream_key = f"md:trades:{exchange}:{symbol}"
    create_consumer_group(r, stream_key, GROUP_NAME)

    print(f"[subscriber] Listening to {stream_key}...")

    while True:
        try:
            messages = r.xreadgroup(
                GROUP_NAME,
                CONSUMER_NAME,
                {stream_key: ">"},
                count=100,
                block=5000,
            )

            if not messages:
                continue

            for stream, entries in messages:
                for msg_id, fields in entries:
                    data = json.loads(fields[b"data"])
                    print(
                        f"  Trade: {data['symbol']} "
                        f"{data['side']} {data['amount']} @ {data['price']}"
                    )

                    # ACK the message
                    r.xack(stream_key, GROUP_NAME, msg_id)

        except KeyboardInterrupt:
            print("\n[subscriber] Stopped.")
            break
        except Exception as e:
            print(f"[subscriber] Error: {e}")
            time.sleep(1)


def subscribe_orderbook(r: redis.Redis, exchange: str, symbol: str) -> None:
    """Subscribe to orderbook stream."""
    stream_key = f"md:orderbook:{exchange}:{symbol}"
    create_consumer_group(r, stream_key, GROUP_NAME)

    print(f"[subscriber] Listening to {stream_key}...")

    while True:
        try:
            messages = r.xreadgroup(
                GROUP_NAME,
                CONSUMER_NAME,
                {stream_key: ">"},
                count=10,
                block=5000,
            )

            if not messages:
                continue

            for stream, entries in messages:
                for msg_id, fields in entries:
                    data = json.loads(fields[b"data"])
                    best_bid = data["bids"][0] if data["bids"] else None
                    best_ask = data["asks"][0] if data["asks"] else None
                    spread = (best_ask[0] - best_bid[0]) if best_bid and best_ask else 0
                    print(
                        f"  OB: {data['symbol']} "
                        f"bid={best_bid} ask={best_ask} spread={spread:.2f}"
                    )
                    r.xack(stream_key, GROUP_NAME, msg_id)

        except KeyboardInterrupt:
            print("\n[subscriber] Stopped.")
            break
        except Exception as e:
            print(f"[subscriber] Error: {e}")
            time.sleep(1)


def get_snapshot(r: redis.Redis, key: str) -> dict | None:
    """Get a snapshot value from Redis."""
    raw = r.get(key)
    if raw is None:
        return None
    return json.loads(raw)


def request_rest_data(
    r: redis.Redis,
    method: str,
    exchange: str,
    args: list,
    timeout: float = 10.0,
) -> dict | None:
    """
    Request REST data via the command pattern.
    Sends command to cmd:rest-request, waits for reply on a temp stream.
    """
    import uuid

    req_id = str(uuid.uuid4())[:8]
    reply_to = f"ml:rest-response:{req_id}"

    r.xadd(
        "cmd:rest-request",
        {
            "data": json.dumps(
                {
                    "method": method,
                    "exchange": exchange,
                    "args": args,
                    "replyTo": reply_to,
                }
            )
        },
    )

    # Wait for response
    start = time.time()
    while time.time() - start < timeout:
        messages = r.xread({reply_to: "0"}, count=1, block=1000)
        if messages:
            for _, entries in messages:
                for _, fields in entries:
                    data = json.loads(fields[b"data"])
                    # Cleanup temp stream
                    r.delete(reply_to)
                    return data
    return None


if __name__ == "__main__":
    import sys

    r = redis.from_url(REDIS_URL, decode_responses=False)

    mode = sys.argv[1] if len(sys.argv) > 1 else "trades"
    exchange = sys.argv[2] if len(sys.argv) > 2 else "binance"
    symbol = sys.argv[3] if len(sys.argv) > 3 else "BTC/USDT:USDT"

    print(f"Mode: {mode}, Exchange: {exchange}, Symbol: {symbol}")

    if mode == "trades":
        subscribe_trades(r, exchange, symbol)
    elif mode == "orderbook":
        subscribe_orderbook(r, exchange, symbol)
    elif mode == "snapshot":
        ob = get_snapshot(r, f"snapshot:ob:{exchange}:{symbol}")
        print(f"Orderbook snapshot: {json.dumps(ob, indent=2)[:500] if ob else 'None'}")
    elif mode == "rest":
        method = sys.argv[4] if len(sys.argv) > 4 else "fetchTicker"
        result = request_rest_data(r, method, exchange, [symbol])
        print(f"REST result: {json.dumps(result, indent=2)[:500] if result else 'Timeout'}")
    else:
        print(f"Unknown mode: {mode}")
        print("Usage: python subscriber.py [trades|orderbook|snapshot|rest] [exchange] [symbol]")
