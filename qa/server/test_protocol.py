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
    ENQUEUE_TRACK,
    EV_ACTIVITY,
    EV_ACTIVITY_LOG,
    EV_STATE,
    JOIN,
    LIMITS,
    NEXT_TRACK,
    PROGRESS,
    REMOVE_QUEUED,
    SEEK_TO,
    SET_VOLUME,
    TOGGLE_PLAY,
    TRACK_ENDED,
    UPDATE_SETTINGS,
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


# ── QUEUE-01/02: enqueue appends to state.queue, logs enqueue, reason null ──
def test_QUEUE_01_02_enqueue_appends(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    c.activities.clear()
    ack = c.call(ENQUEUE_TRACK, {"url": VALID_URL})  # no reason
    assert ack["ok"] is True
    c.wait_event(3.0)
    st = c.last_state()
    assert st is not None
    assert any(t["id"] == VALID_ID for t in st["queue"])
    assert st["currentTrack"] is None  # currentTrack unchanged
    enq = [a for a in c.activities if a["type"] == "enqueue"]
    assert enq and enq[-1]["reason"] is None  # QUEUE-02: optional reason


# ── QUEUE-06: out-of-range removeQueued index is rejected, queue unchanged ──
def test_QUEUE_06_remove_out_of_range(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    ack = c.call(REMOVE_QUEUED, {"index": 5})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid index"


# ── QUEUE-07: nextTrack promotes head to currentTrack and shrinks queue ─────
def test_QUEUE_07_next_track_advances(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    c.states.clear()
    c.activities.clear()
    ack = c.call(NEXT_TRACK, {})
    assert ack["ok"] is True
    c.wait_event(3.0)
    st = c.last_state()
    assert st["currentTrack"]["id"] == VALID_ID
    assert len(st["queue"]) == 0
    assert st["isPlaying"] is True
    assert any(a["type"] == "skip" for a in c.activities)


# ── QUEUE-08: nextTrack on an empty queue is an ok no-op ────────────────────
def test_QUEUE_08_next_track_empty_noop(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    ack = c.call(NEXT_TRACK, {})
    assert ack["ok"] is True
    # No broadcast / state change expected.
    assert c.wait_event(2.0) is False


# ── QUEUE-09: a Player's trackEnded auto-advances the queue ─────────────────
def test_QUEUE_09_track_ended_advances(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    assert controller.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    player.states.clear()
    player.activities.clear()
    ack = player.call(TRACK_ENDED, {})
    assert ack["ok"] is True
    player.wait_event(3.0)
    st = player.last_state()
    assert st["currentTrack"]["id"] == VALID_ID
    assert len(st["queue"]) == 0
    skips = [a for a in player.activities if a["type"] == "skip"]
    assert skips and skips[-1].get("detail", {}).get("auto") is True


# ── QUEUE-11: queue control (enqueue/nextTrack) is controllers only ─────────
def test_QUEUE_11_queue_control_controllers_only(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    assert p.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is False
    assert p.call(NEXT_TRACK, {})["ok"] is False


# ── QUEUE-12: trackEnded is player only (controller rejected) ───────────────
def test_QUEUE_12_track_ended_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    ack = c.call(TRACK_ENDED, {})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


# ── SEEK-01/02: seekTo updates lastSeek + logs a seek (reason optional) ─────
def test_SEEK_01_02_seek_updates_last_seek_and_logs(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    c.activities.clear()
    ack = c.call(SEEK_TO, {"seconds": 42})  # no reason
    assert ack["ok"] is True
    c.wait_event(3.0)
    st = c.last_state()
    assert st is not None
    assert st["lastSeek"]["seconds"] == 42
    seeks = [a for a in c.activities if a["type"] == "seek"]
    assert seeks  # SEEK-01: a seek activity is logged
    assert seeks[-1].get("detail", {}).get("seconds") == 42
    assert seeks[-1]["reason"] is None  # SEEK-02: reason optional → null


# ── SEEK-03: negative seconds rejected, lastSeek unchanged ──────────────────
def test_SEEK_03_negative_seconds_rejected(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    ack = c.call(SEEK_TO, {"seconds": -5})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid seconds"


# ── SEEK-05: seekTo is controllers only (player rejected) ───────────────────
def test_SEEK_05_seek_controllers_only(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    ack = p.call(SEEK_TO, {"seconds": 10})
    assert ack["ok"] is False


# ── SEEK-06: a Player's progress updates state.progress, no activity entry ──
def test_SEEK_06_progress_updates_state_no_log(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    controller.states.clear()
    controller.activities.clear()
    ack = player.call(PROGRESS, {"currentTime": 12, "duration": 200})
    assert ack["ok"] is True
    controller.wait_event(3.0)
    st = controller.last_state()
    assert st is not None
    assert st["progress"]["currentTime"] == 12
    assert st["progress"]["duration"] == 200
    # High-frequency reports are NOT logged.
    assert all(a["type"] != "seek" for a in controller.activities)
    assert controller.activities == []


# ── SEEK-08: progress is player only (controller rejected) ──────────────────
def test_SEEK_08_progress_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    ack = c.call(PROGRESS, {"currentTime": 1, "duration": 100})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


# ── SET-01: updateSettings broadcasts new settings + logs settings activity ─
def test_SET_01_update_settings_broadcasts(make_client):
    controller = make_client()
    observer = make_client()
    room = room_code()
    controller.join(room)
    observer.join(room, role="player")
    observer.states.clear()
    observer.activities.clear()
    ack = controller.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})
    assert ack["ok"] is True
    observer.wait_event(3.0)
    st = observer.last_state()
    assert st is not None
    assert st["settings"]["allowAnonymous"] is False
    assert any(a["type"] == "settings" for a in observer.activities)


# ── SET-02: anon controller's changeTrack rejected when allowAnonymous=false ─
def test_SET_02_anon_change_track_rejected(make_client):
    c = make_client()  # joins WITHOUT a nickname → anonymous
    room = room_code()
    c.join(room)
    assert c.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "set the vibe"})
    assert ack["ok"] is False
    assert ack.get("error") == "nickname required"


# ── SET-03: a nicknamed controller can changeTrack when allowAnonymous=false ─
def test_SET_03_named_change_track_ok(make_client):
    named = make_client()
    room = room_code()
    named.join(room, nickname="dj")
    assert named.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    named.states.clear()
    ack = named.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "i have a nickname"})
    assert ack["ok"] is True
    named.wait_event(3.0)
    assert named.last_state()["currentTrack"]["id"] == VALID_ID


# ── SET-04: setVolume from an anon controller is NOT gated (no lockout) ──────
def test_SET_04_anon_set_volume_not_gated(make_client):
    c = make_client()  # anonymous
    room = room_code()
    c.join(room)
    assert c.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    c.states.clear()
    ack = c.call(SET_VOLUME, {"volume": 42})
    assert ack["ok"] is True
    c.wait_event(3.0)
    assert c.last_state()["volume"] == 42
