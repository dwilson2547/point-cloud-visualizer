"""Minimal Apache Iggy HTTP client for publishers (docs/pubsub.md). Probed against
apache/iggy:0.8.0: partitions are zero-indexed, topic expiry/size are integers with 0
meaning unlimited, payloads travel base64-encoded, tokens last an hour."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request

PARTITION_0 = base64.b64encode(b"\x00\x00\x00\x00").decode()


class IggyHttp:
    def __init__(self, url: str, username: str = "iggy", password: str = "iggy") -> None:
        self.url = url.rstrip("/")
        self.username = username
        self.password = password
        self.token: str | None = None

    def login(self) -> None:
        body = self._raw("POST", "/users/login", {"username": self.username, "password": self.password}, auth=False)
        self.token = json.loads(body)["access_token"]["token"]

    def ensure_stream(self, name: str) -> None:
        if self._request("POST", "/streams", {"name": name}, tolerate=(400, 409)) is None:
            self._request("GET", f"/streams/{name}")

    def ensure_topic(self, stream: str, topic: str) -> None:
        created = self._request(
            "POST",
            f"/streams/{stream}/topics",
            {"name": topic, "partitions_count": 1, "compression_algorithm": "none", "message_expiry": 0, "max_topic_size": 0},
            tolerate=(400, 409),
        )
        if created is None:
            self._request("GET", f"/streams/{stream}/topics/{topic}")

    def send(self, stream: str, topic: str, payloads: list[bytes]) -> None:
        if not payloads:
            return
        self._request(
            "POST",
            f"/streams/{stream}/topics/{topic}/messages",
            {
                "partitioning": {"kind": "partition_id", "value": PARTITION_0},
                "messages": [{"payload": base64.b64encode(p).decode()} for p in payloads],
            },
        )

    def _request(self, method: str, path: str, body: dict | None = None, tolerate: tuple[int, ...] = ()) -> bytes | None:
        """Authenticated request; returns the body, or None for a tolerated error status."""
        if self.token is None:
            self.login()
        try:
            return self._raw(method, path, body)
        except urllib.error.HTTPError as error:
            if error.code == 401:
                self.login()
                return self._raw(method, path, body)
            if error.code in tolerate:
                return None
            raise

    def _raw(self, method: str, path: str, body: dict | None, auth: bool = True) -> bytes:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"content-type": "application/json"} if data is not None else {}
        if auth and self.token:
            headers["authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(f"{self.url}{path}", data=data, headers=headers, method=method)
        with urllib.request.urlopen(request) as response:
            return response.read()
