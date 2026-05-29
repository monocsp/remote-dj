"""Black-box server protocol acceptance tests (python-socketio client).

Each test maps to a scenario ID in docs/qa/*.md. Expectations come from the
acceptance docs / SPEC, NOT from server source. Event names + limits come from
qa/contract.json via contract.py (no TS import).
"""

from __future__ import annotations

import random
import string
import threading

import pytest
import socketio

from contract import (
    CHANGE_TRACK,
    EV_ACTIVITY,
    EV_ACTIVITY_LOG,
    EV_STATE,
    JOIN,
    LIMITS,
    SET_VOLUME,
    TOGGLE_PLAY,
)

ROOM_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
VALID_URL = "https://youtu.be/dQw4w9WgXcQ"
VALID_ID = "dQw4w9WgXcQ"
ACK_TIMEOUT = 5


def room_code() -> str:
    return "".join(random.choice(ROOM_CHARSET) for _ in range(6))


class Client:
    """Thin Socket.IO client that buffers state/activity events for assertions."""

    def __init__(self, url: str):
        self.sio = socketio.Client(reconnection=False)
        self.states: list[dict] = []
        self.activities: list[dict] = []
        self.activity_log: list | None = None
        self._got_event = threading.Event()

        @self.sio.on(EV_STATE)
        def _on_state(data):  # noqa: ANN001
            self.states.append(data)
            self._got_event.set()

        @self.sio.on(EV_ACTIVITY)
        def _on_activity(data):  # noqa: ANN001
            self.activities.append(data)
            self._got_event.set()

        @self.sio.on(EV_ACTIVITY_LOG)
        def _on_log(data):  # noqa: ANN001
            self.activity_log = data

        self.sio.connect(url, transports=["websocket"], wait_timeout=ACK_TIMEOUT)

    def join(self, room: str, role: str = "controller", **kw) -> dict:
        payload = {"roomCode": room, "role": role, **kw}
        return self.sio.call(JOIN, payload, timeout=ACK_TIMEOUT)

    def call(self, event: str, payload: dict) -> dict:
        return self.sio.call(event, payload, timeout=ACK_TIMEOUT)

    def wait_event(self, timeout: float = 3.0) -> bool:
        """Block until any state/activity arrives (or timeout). Returns success."""
        self._got_event.clear()
        return self._got_event.wait(timeout)

    def last_state(self) -> dict | None:
        return self.states[-1] if self.states else None

    def close(self) -> None:
        try:
            self.sio.disconnect()
        except Exception:  # noqa: BLE001
            pass


@pytest.fixture()
def make_client(server_url):
    clients: list[Client] = []

    def _make() -> Client:
        c = Client(server_url)
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.close()


# ── TRK-01: reason required ────────────────────────────────────────────────
def test_TRK_01_reason_required(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "   "})
    assert ack["ok"] is False
    assert ack.get("error") == "reason required"


# ── TRK-02: invalid youtube url ────────────────────────────────────────────
def test_TRK_02_invalid_url(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    ack = c.call(CHANGE_TRACK, {"url": "https://example.com/x", "reason": "테스트"})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid youtube url"


# ── TRK-03/04: valid change broadcasts + activity logged with reason ───────
def test_TRK_03_04_valid_change(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    c.activities.clear()
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "분위기"})
    assert ack["ok"] is True
    c.wait_event(3.0)
    st = c.last_state()
    assert st is not None
    assert st["currentTrack"]["id"] == VALID_ID
    assert st["isPlaying"] is True
    track_acts = [a for a in c.activities if a["type"] == "track_change"]
    assert track_acts and track_acts[-1]["reason"] is not None


# ── VOL-01/02/03: volume clamp + round ─────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [(150, 100), (-20, 0), (42.6, 43)])
def test_VOL_clamp(make_client, raw, expected):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    ack = c.call(SET_VOLUME, {"volume": raw})
    assert ack["ok"] is True
    c.wait_event(3.0)
    assert c.last_state()["volume"] == expected


# ── PLY-03: controllers only (player rejected) ─────────────────────────────
def test_PLY_03_controller_only(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    for event, payload in [
        (SET_VOLUME, {"volume": 30}),
        (TOGGLE_PLAY, {"isPlaying": True}),
        (CHANGE_TRACK, {"url": VALID_URL, "reason": "x"}),
    ]:
        ack = p.call(event, payload)
        assert ack["ok"] is False


# ── PAIR-05/06/07: password create / wrong / correct ───────────────────────
def test_PAIR_password_flow(make_client):
    room = room_code()
    creator = make_client()
    assert creator.join(room, password="secret")["ok"] is True  # PAIR-05

    wrong = make_client()
    ack = wrong.join(room, password="nope")  # PAIR-06
    assert ack["ok"] is False
    assert ack.get("error") == "wrong password"

    right = make_client()
    assert right.join(room, password="secret")["ok"] is True  # PAIR-07


# ── PAIR-08: open room ignores password ────────────────────────────────────
def test_PAIR_08_open_room_ignores_password(make_client):
    room = room_code()
    make_client().join(room)  # create open room (no password)
    joiner = make_client()
    assert joiner.join(room, password="whatever")["ok"] is True


# ── RT-02: room-switch isolation ───────────────────────────────────────────
def test_RT_02_room_isolation(make_client):
    r1, r2 = room_code(), room_code()
    mover = make_client()
    other = make_client()
    mover.join(r1)
    other.join(r1)
    # Mover switches to a different room.
    mover.join(r2)
    mover.states.clear()
    mover.activities.clear()
    # Activity happens back in r1; mover must NOT receive it.
    other.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "in r1"})
    got = mover.wait_event(2.0)
    assert got is False
    assert all(a.get("detail", {}).get("id") != VALID_ID for a in mover.activities)


# ── RT-03: presence counts ─────────────────────────────────────────────────
def test_RT_03_presence(make_client):
    room = room_code()
    player = make_client()
    c1 = make_client()
    c2 = make_client()
    player.join(room, role="player")
    c1.join(room)
    c2.states.clear()
    c2.join(room)
    c2.wait_event(3.0)
    st = c2.last_state()
    assert st["presence"]["playerConnected"] is True
    assert st["presence"]["controllers"] == 2


# ── RT-05: stateVersion strictly increases ─────────────────────────────────
def test_RT_05_state_version_increases(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    c.call(SET_VOLUME, {"volume": 10})
    c.wait_event(3.0)
    v1 = c.last_state()["stateVersion"]
    c.call(SET_VOLUME, {"volume": 20})
    c.wait_event(3.0)
    v2 = c.last_state()["stateVersion"]
    assert v2 > v1


# ── LOG-05: full log delivered on join ─────────────────────────────────────
def test_LOG_05_log_on_join(make_client):
    room = room_code()
    a = make_client()
    a.join(room)
    a.call(SET_VOLUME, {"volume": 30})
    a.call(TOGGLE_PLAY, {"isPlaying": True})
    a.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "곡"})
    b = make_client()
    b.join(room)
    # activityLog is delivered synchronously around join; give it a beat.
    b.wait_event(2.0)
    assert b.activity_log is not None
    assert len(b.activity_log) >= 3
    assert any(e["type"] == "track_change" for e in b.activity_log)


# ── RT-07: input length caps (reason boundary + over) ──────────────────────
def test_RT_07_reason_length_cap(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    at_limit = "a" * LIMITS["reason"]
    over = "a" * (LIMITS["reason"] + 1)
    # Exactly at limit with a valid url is accepted.
    assert c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": at_limit})["ok"] is True
    # Over the limit is rejected.
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": over})
    assert ack["ok"] is False


# ── RT-07: nickname cap at join ────────────────────────────────────────────
def test_RT_07_nickname_length_cap(make_client):
    c = make_client()
    room = room_code()
    over = "n" * (LIMITS["nickname"] + 1)
    ack = c.join(room, nickname=over)
    assert ack["ok"] is False
