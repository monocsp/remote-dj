"""Black-box server protocol acceptance tests (python-socketio client).

Each test maps to a scenario ID in docs/qa/*.md. Expectations come from the
acceptance docs / SPEC, NOT from server source. Event names + limits come from
qa/contract.json via contract.py (no TS import).
"""

from __future__ import annotations

import random
import string
import threading
import time

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
    PLAYBACK_ERROR,
    PROGRESS,
    REMOVE_QUEUED,
    SEEK_TO,
    SET_REPEAT,
    SET_SHUFFLE,
    SET_TRACK_GAIN,
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

    def wait_for_state(self, predicate, timeout: float = 3.0) -> dict | None:
        """Block until a received `state` satisfies `predicate` (or timeout).

        Deterministic across the activity-before-state emit order: the server
        emits the `activity` event before the `state` broadcast, so a plain
        `wait_event()` can wake on the activity and read a stale/empty state.
        """
        deadline = time.monotonic() + timeout
        while True:
            for s in list(self.states):
                if predicate(s):
                    return s
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self._got_event.clear()
            self._got_event.wait(remaining)

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


# ── TITLE-01: server fills currentTrack.title from YouTube oEmbed (async) ───
def test_TITLE_01_title_autofill(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    # No title provided: the server fills it asynchronously and re-broadcasts.
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "분위기"})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: (s.get("currentTrack") or {}).get("title") == "QA Title")
    assert st is not None
    assert st["currentTrack"]["title"] == "QA Title"


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
    st = observer.wait_for_state(lambda s: s.get("settings", {}).get("allowAnonymous") is False)
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


# ── ERR-01: a Player's playbackError sets broadcast state.playbackError.code ─
def test_ERR_01_playback_error_sets_state(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    controller.states.clear()
    ack = player.call(PLAYBACK_ERROR, {"code": 100})
    assert ack["ok"] is True
    controller.wait_event(3.0)
    st = controller.last_state()
    assert st is not None
    assert st["playbackError"]["code"] == 100


# ── ERR-02: a subsequent changeTrack clears playbackError to null ───────────
def test_ERR_02_change_track_clears_playback_error(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    assert player.call(PLAYBACK_ERROR, {"code": 100})["ok"] is True
    controller.states.clear()
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "recover"})["ok"] is True
    controller.wait_event(3.0)
    st = controller.last_state()
    assert st is not None
    assert st["currentTrack"]["id"] == VALID_ID
    assert st["playbackError"] is None


# ── ERR-03: playbackError is player only (controller rejected) ──────────────
def test_ERR_03_playback_error_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    ack = c.call(PLAYBACK_ERROR, {"code": 100})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


# ── RT-04: presence.controllers decrements when a controller disconnects ────
def test_RT_04_presence_decrements_on_disconnect(make_client):
    room = room_code()
    c1 = make_client()
    c2 = make_client()
    c1.join(room)
    c2.join(room)
    # Both controllers present.
    st = c2.wait_for_state(lambda s: s.get("presence", {}).get("controllers") == 2)
    assert st is not None
    # c1 disconnects; the server recomputes presence and rebroadcasts.
    c2.states.clear()
    c1.close()
    st = c2.wait_for_state(lambda s: s.get("presence", {}).get("controllers") == 1)
    assert st is not None
    assert st["presence"]["controllers"] == 1
    assert st["presence"]["playerConnected"] is False


# ── RT-06: a fresh socket joining a room resyncs to current track + log ─────
def test_RT_06_reconnect_resync(make_client):
    room = room_code()
    a = make_client()
    a.join(room)
    assert a.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "분위기"})["ok"] is True
    # A brand-new socket joins the same room and must receive the latest state.
    b = make_client()
    b.join(room)
    st = b.wait_for_state(lambda s: (s.get("currentTrack") or {}).get("id") == VALID_ID)
    assert st is not None
    assert st["currentTrack"]["id"] == VALID_ID
    # The full activity log delivered on join includes the track_change.
    b.wait_event(2.0)
    assert b.activity_log is not None
    assert any(e["type"] == "track_change" for e in b.activity_log)


# ── QUEUE-13: removeQueued at index 0 drops head, keeps the rest ────────────
def test_QUEUE_13_remove_queued_happy_path(make_client):
    second_url = "https://youtu.be/9bZkp7q19f0"
    second_id = "9bZkp7q19f0"
    c = make_client()
    room = room_code()
    c.join(room)
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    assert c.call(ENQUEUE_TRACK, {"url": second_url})["ok"] is True
    c.states.clear()
    ack = c.call(REMOVE_QUEUED, {"index": 0})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: len(s.get("queue", [])) == 1)
    assert st is not None
    assert len(st["queue"]) == 1
    assert st["queue"][0]["id"] == second_id


# ── SEEK-09: invalid progress payloads are rejected ─────────────────────────
def test_SEEK_09_invalid_progress_rejected(make_client):
    player = make_client()
    room = room_code()
    player.join(room, role="player")
    # Non-number currentTime → rejected (typeof check). NaN is intentionally
    # avoided: it is not JSON-serializable, so it can't cross the wire here —
    # the not-finite path is covered by the vitest integration test instead.
    type_ack = player.call(PROGRESS, {"currentTime": "x", "duration": 100})
    assert type_ack["ok"] is False
    # Negative currentTime.
    neg_ack = player.call(PROGRESS, {"currentTime": -1, "duration": 100})
    assert neg_ack["ok"] is False


# ── ERR-04: a non-number playbackError code is rejected ─────────────────────
def test_ERR_04_invalid_playback_error_code_rejected(make_client):
    player = make_client()
    room = room_code()
    player.join(room, role="player")
    ack = player.call(PLAYBACK_ERROR, {"code": "x"})
    assert ack["ok"] is False


# ── SEC-01: the room password never appears in any broadcast state ──────────
def test_SEC_01_password_not_in_state(make_client):
    import json as _json

    room = room_code()
    creator = make_client()
    assert creator.join(room, password="secret")["ok"] is True
    observer = make_client()
    assert observer.join(room, role="player", password="secret")["ok"] is True
    # Trigger another broadcast to exercise more than the join state.
    assert creator.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "분위기"})["ok"] is True
    observer.wait_for_state(lambda s: (s.get("currentTrack") or {}).get("id") == VALID_ID)
    assert observer.states  # received at least one state
    for s in observer.states:
        assert "password" not in s
        assert "secret" not in _json.dumps(s)


# ── GAIN-01: setTrackGain broadcasts trackGain[id] + logs a gain activity ───
def test_GAIN_01_set_track_gain_manual(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    c.activities.clear()
    ack = c.call(SET_TRACK_GAIN, {"videoId": VALID_ID, "gain": 0.5})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: s.get("trackGain", {}).get(VALID_ID) == 0.5)
    assert st is not None
    assert st["trackGain"][VALID_ID] == 0.5
    gains = [a for a in c.activities if a["type"] == "gain"]
    assert gains and gains[-1].get("detail", {}).get("gain") == 0.5


# ── GAIN-03: changeTrack auto-seeds trackGain from YouTube loudnessDb ────────
def test_GAIN_03_auto_seed_from_loudness(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    # No manual gain: the server auto-seeds from loudnessDb (env +6 dB ⇒ ~0.5).
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "분위기"})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: 0 < s.get("trackGain", {}).get(VALID_ID, 1) < 1)
    assert st is not None
    assert 0 < st["trackGain"][VALID_ID] < 1


SECOND_URL = "https://youtu.be/9bZkp7q19f0"
SECOND_ID = "9bZkp7q19f0"


# ── MODE-01: setRepeat broadcasts state.repeat + logs a mode activity ────────
def test_MODE_01_set_repeat_broadcasts_and_logs(make_client):
    controller = make_client()
    observer = make_client()
    room = room_code()
    controller.join(room)
    observer.join(room, role="player")
    observer.states.clear()
    observer.activities.clear()
    ack = controller.call(SET_REPEAT, {"mode": "all"})
    assert ack["ok"] is True
    st = observer.wait_for_state(lambda s: s.get("repeat") == "all")
    assert st is not None
    assert st["repeat"] == "all"
    modes = [a for a in observer.activities if a["type"] == "mode"]
    assert modes and modes[-1].get("detail", {}).get("repeat") == "all"


# ── MODE-02: setShuffle broadcasts state.shuffle ────────────────────────────
def test_MODE_02_set_shuffle_broadcasts(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    ack = c.call(SET_SHUFFLE, {"shuffle": True})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: s.get("shuffle") is True)
    assert st is not None
    assert st["shuffle"] is True


# ── REPEAT-ALL: empty queue under repeat 'all' loops back from history ──────
def test_REPEAT_ALL_loops_from_history(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    assert controller.call(SET_REPEAT, {"mode": "all"})["ok"] is True
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: (s.get("currentTrack") or {}).get("id") == VALID_ID)
    assert controller.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True

    # First trackEnded promotes B; A moves into server-only history.
    assert player.call(TRACK_ENDED, {})["ok"] is True
    st = player.wait_for_state(
        lambda s: (s.get("currentTrack") or {}).get("id") == SECOND_ID
        and len(s.get("queue", [])) == 0
    )
    assert st is not None

    # Second trackEnded: empty queue + repeat 'all' loops back to A.
    assert player.call(TRACK_ENDED, {})["ok"] is True
    st = player.wait_for_state(
        lambda s: (s.get("currentTrack") or {}).get("id") == VALID_ID and s.get("isPlaying") is True
    )
    assert st is not None
    assert st["currentTrack"]["id"] == VALID_ID
    assert st["isPlaying"] is True


# ── OFF-STOP: empty queue under repeat 'off' stops playback ─────────────────
def test_OFF_STOP_stops_on_empty_queue(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    # repeat defaults to 'off'.
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(
        lambda s: (s.get("currentTrack") or {}).get("id") == VALID_ID and s.get("isPlaying") is True
    )
    assert player.call(TRACK_ENDED, {})["ok"] is True
    st = player.wait_for_state(
        lambda s: s.get("isPlaying") is False
        and (s.get("currentTrack") or {}).get("id") == VALID_ID
    )
    assert st is not None
    assert st["isPlaying"] is False
    assert st["currentTrack"]["id"] == VALID_ID
