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
    JUMP_TO,
    LIMITS,
    NEXT_TRACK,
    PLAYBACK_ERROR,
    PROGRESS,
    REMOVE_QUEUED,
    SEEK_TO,
    SHUFFLE_QUEUE,
    SET_REPEAT,
    SET_SCHEDULE,
    SET_TRACK_GAIN,
    SET_VOLUME,
    TOGGLE_PLAY,
    TRACK_ENDED,
    UPDATE_SETTINGS,
)


def _cur(state) -> dict:
    """Current track = playlist[currentIndex] (None when idle/empty)."""
    if not state:
        return {}
    pl = state.get("playlist") or []
    idx = state.get("currentIndex", -1)
    if idx is None or idx < 0 or idx >= len(pl):
        return {}
    return pl[idx] or {}


def _upcoming(state) -> list:
    """The slice of the playlist after the cursor (the 'queue')."""
    if not state:
        return []
    pl = state.get("playlist") or []
    idx = state.get("currentIndex", -1)
    if idx is None or idx < 0:
        return list(pl)
    return pl[idx + 1 :]

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
    assert _cur(st)["id"] == VALID_ID
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
    st = c.wait_for_state(lambda s: _cur(s).get("title") == "QA Title")
    assert st is not None
    assert _cur(st)["title"] == "QA Title"


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


# ── PLY-03: guest events allowed from a player (changeTrack/setVolume/togglePlay) ─
def test_PLY_03_player_allowed_guest_events(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    # GUEST events: both roles may emit. A player (the MAIN) is allowed.
    for event, payload in [
        (SET_VOLUME, {"volume": 30}),
        (TOGGLE_PLAY, {"isPlaying": True}),
        (CHANGE_TRACK, {"url": VALID_URL, "reason": "x"}),
        (ENQUEUE_TRACK, {"url": VALID_URL}),
        (SET_TRACK_GAIN, {"videoId": VALID_ID, "gain": 0.5}),
    ]:
        ack = p.call(event, payload)
        assert ack["ok"] is True


# ── PLY-03b: main events rejected from a controller (player only) ──────────
def test_PLY_03b_controller_rejected_main_events(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room, role="controller")["ok"] is True
    # MAIN events: player-only. A controller (limited guest) is rejected.
    # NOTE: removeQueued is NOT here — it is a member action gated by ownership
    # (covered by RMOWN/RMOTHER/RMPLAYER below), not a flat player-only event.
    for event, payload in [
        (NEXT_TRACK, {}),
        (SET_REPEAT, {"mode": "all"}),
        (JUMP_TO, {"index": 0}),
        (SEEK_TO, {"seconds": 10}),
        (UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}}),
        (SET_SCHEDULE, {"schedule": None}),
    ]:
        ack = c.call(event, payload)
        assert ack["ok"] is False
        assert ack.get("error") == "player only"


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


SECOND_URL = "https://youtu.be/9bZkp7q19f0"
SECOND_ID = "9bZkp7q19f0"


# ── QUEUE-14: enqueue into an IDLE room auto-starts that track ───────────────
def test_QUEUE_14_enqueue_into_idle_auto_starts(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    c.states.clear()
    c.activities.clear()
    # Fresh idle room (currentIndex -1): the first enqueue auto-starts it.
    ack = c.call(ENQUEUE_TRACK, {"url": VALID_URL})  # no reason
    assert ack["ok"] is True
    st = c.wait_for_state(
        lambda s: _cur(s).get("id") == VALID_ID
        and s.get("isPlaying") is True
        and len(_upcoming(s)) == 0
    )
    assert st is not None
    assert _cur(st)["id"] == VALID_ID
    assert st["isPlaying"] is True
    assert len(_upcoming(st)) == 0
    assert any(a["type"] == "enqueue" for a in c.activities)


# ── QUEUE-01/02: enqueue while playing appends to queue, logs enqueue, reason null ──
def test_QUEUE_01_02_enqueue_appends(make_client):
    c = make_client()
    room = room_code()
    c.join(room)
    # Establish a playing current track (A) first so the next enqueue (B) queues
    # instead of auto-starting (QUEUE-14).
    assert c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    c.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    c.states.clear()
    c.activities.clear()
    ack = c.call(ENQUEUE_TRACK, {"url": SECOND_URL})  # no reason
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    assert st is not None
    assert any(t["id"] == SECOND_ID for t in _upcoming(st))
    assert _cur(st)["id"] == VALID_ID  # current unchanged (A)
    enq = [a for a in c.activities if a["type"] == "enqueue"]
    assert enq and enq[-1]["reason"] is None  # QUEUE-02: optional reason


# ── QUEUE-06: out-of-range removeQueued index is rejected, queue unchanged ──
def test_QUEUE_06_remove_out_of_range(make_client):
    p = make_client()
    room = room_code()
    p.join(room, role="player")  # player may remove any item
    ack = p.call(REMOVE_QUEUED, {"index": 5})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid index"


# ── QUEUE-07: nextTrack promotes head to currentTrack and shrinks queue ─────
def test_QUEUE_07_next_track_advances(make_client):
    c = make_client()
    room = room_code()
    c.join(room, role="player")  # nextTrack is a MAIN action: player-only
    # A becomes current (auto-start); B then queues behind it.
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    c.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert c.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    c.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    c.states.clear()
    c.activities.clear()
    ack = c.call(NEXT_TRACK, {})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: _cur(s).get("id") == SECOND_ID)
    assert st is not None
    assert _cur(st)["id"] == SECOND_ID
    assert len(_upcoming(st)) == 0
    assert st["isPlaying"] is True
    assert any(a["type"] == "skip" for a in c.activities)


# ── QUEUE-08: nextTrack on an empty queue is an ok no-op ────────────────────
def test_QUEUE_08_next_track_empty_noop(make_client):
    c = make_client()
    room = room_code()
    c.join(room, role="player")  # nextTrack is a MAIN action: player-only
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
    # A becomes current (auto-start); B then queues behind it.
    assert controller.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert controller.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    player.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    player.states.clear()
    player.activities.clear()
    ack = player.call(TRACK_ENDED, {})
    assert ack["ok"] is True
    st = player.wait_for_state(lambda s: _cur(s).get("id") == SECOND_ID)
    assert st is not None
    assert _cur(st)["id"] == SECOND_ID
    assert len(_upcoming(st)) == 0
    skips = [a for a in player.activities if a["type"] == "skip"]
    assert skips and skips[-1].get("detail", {}).get("auto") is True


# ── QUEUE-11: enqueue is a GUEST event (both roles); a player may enqueue + next ─
def test_QUEUE_11_player_can_enqueue_and_next(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    # enqueue is a GUEST event (both roles allowed); a player (MAIN) is allowed.
    assert p.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    # nextTrack is a MAIN action: a player may advance.
    assert p.call(NEXT_TRACK, {})["ok"] is True


# ── QUEUE-11b: a controller may enqueue (guest event) ──────────────────────
def test_QUEUE_11b_controller_can_enqueue(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room, role="controller")["ok"] is True
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True


# ── NEXT-PLAYER: a Player may press "다음 곡" and advance the queue ──────────
def test_NEXT_PLAYER_player_can_advance(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    # A becomes current (auto-start); B then queues behind it.
    assert controller.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert controller.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    player.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    player.states.clear()
    ack = player.call(NEXT_TRACK, {})
    assert ack["ok"] is True
    st = player.wait_for_state(lambda s: _cur(s).get("id") == SECOND_ID)
    assert st is not None
    assert _cur(st)["id"] == SECOND_ID
    assert len(_upcoming(st)) == 0


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
    c.join(room, role="player")  # seekTo is a MAIN action: player-only
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
    c.join(room, role="player")  # seekTo is a MAIN action: player-only
    ack = c.call(SEEK_TO, {"seconds": -5})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid seconds"


# ── SEEK-05: seekTo is a MAIN action (controller rejected, player only) ─────
def test_SEEK_05_seek_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room, role="controller")["ok"] is True
    ack = c.call(SEEK_TO, {"seconds": 10})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


# ── SEEK-06: a Player's progress updates state.progress, no activity entry ──
def test_SEEK_06_progress_updates_state_no_log(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    # Set a current track so progress is stamped with its id.
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "곡"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    controller.states.clear()
    controller.activities.clear()
    ack = player.call(PROGRESS, {"currentTime": 12, "duration": 200})
    assert ack["ok"] is True
    st = controller.wait_for_state(lambda s: (s.get("progress") or {}).get("currentTime") == 12)
    assert st is not None
    assert st["progress"]["currentTime"] == 12
    assert st["progress"]["duration"] == 200
    # The server stamps the progress with the current track id.
    assert st["progress"]["id"] == VALID_ID
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
    player = make_client()
    observer = make_client()
    room = room_code()
    player.join(room, role="player")  # updateSettings is a MAIN action: player-only
    observer.join(room, role="controller")
    observer.states.clear()
    observer.activities.clear()
    ack = player.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})
    assert ack["ok"] is True
    st = observer.wait_for_state(lambda s: s.get("settings", {}).get("allowAnonymous") is False)
    assert st is not None
    assert st["settings"]["allowAnonymous"] is False
    assert any(a["type"] == "settings" for a in observer.activities)


# ── SET-02: anon controller's changeTrack rejected when allowAnonymous=false ─
def test_SET_02_anon_change_track_rejected(make_client):
    player = make_client()  # player flips the setting (updateSettings is main-only)
    c = make_client()  # joins WITHOUT a nickname → anonymous controller
    room = room_code()
    player.join(room, role="player")
    c.join(room, role="controller")
    assert player.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    ack = c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "set the vibe"})
    assert ack["ok"] is False
    assert ack.get("error") == "nickname required"


# ── SET-02b: an anon PLAYER changeTrack is NOT gated (player/MAIN never gated) ─
def test_SET_02b_anon_player_change_track_not_gated(make_client):
    p = make_client()  # anonymous player
    room = room_code()
    p.join(room, role="player")
    assert p.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    ack = p.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "main is never gated"})
    assert ack["ok"] is True


# ── SET-03: a nicknamed controller can changeTrack when allowAnonymous=false ─
def test_SET_03_named_change_track_ok(make_client):
    player = make_client()
    named = make_client()
    room = room_code()
    player.join(room, role="player")
    named.join(room, role="controller", nickname="dj")
    assert player.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    named.states.clear()
    ack = named.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "i have a nickname"})
    assert ack["ok"] is True
    named.wait_event(3.0)
    assert _cur(named.last_state())["id"] == VALID_ID


# ── SET-04: setVolume from an anon controller is NOT gated (no lockout) ──────
def test_SET_04_anon_set_volume_not_gated(make_client):
    player = make_client()
    c = make_client()  # anonymous controller
    room = room_code()
    player.join(room, role="player")
    c.join(room, role="controller")
    assert player.call(UPDATE_SETTINGS, {"settings": {"allowAnonymous": False}})["ok"] is True
    c.states.clear()
    ack = c.call(SET_VOLUME, {"volume": 42})
    assert ack["ok"] is True
    c.wait_event(3.0)
    assert c.last_state()["volume"] == 42


# NOTE: the changeTrack/enqueue embeddability reject path ('embed disabled') is
# NOT black-box testable here — the spawned server runs with REMOTE_DJ_FAKE_TITLE
# set, so defaultResolveEmbeddable always returns true (fail-open, no network).
# That path is covered by the vitest EMB-01 integration test.


# ── ERR-01: a Player's playbackError auto-skips to the next track + logs error ─
def test_ERR_01_playback_error_auto_skips(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    # A becomes current; B queues behind it → upcoming = [B].
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert controller.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    player.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    controller.states.clear()
    controller.activities.clear()
    # The bad current track errors → server auto-skips to B and logs an 'error'.
    ack = player.call(PLAYBACK_ERROR, {"code": 150})
    assert ack["ok"] is True
    st = controller.wait_for_state(lambda s: _cur(s).get("id") == SECOND_ID)
    assert st is not None
    assert _cur(st)["id"] == SECOND_ID
    errors = [a for a in controller.activities if a["type"] == "error"]
    assert errors and errors[-1].get("detail", {}).get("code") == 150


# ── ERR-02: a playbackError with an empty queue stops and keeps the error ────
def test_ERR_02_playback_error_empty_queue_stops(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    # A becomes current with no upcoming tracks.
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    controller.states.clear()
    controller.activities.clear()
    ack = player.call(PLAYBACK_ERROR, {"code": 2})
    assert ack["ok"] is True
    st = controller.wait_for_state(
        lambda s: s.get("isPlaying") is False and (s.get("playbackError") or {}).get("code") == 2
    )
    assert st is not None
    assert st["isPlaying"] is False
    assert st["playbackError"]["code"] == 2
    assert any(a["type"] == "error" for a in controller.activities)


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
    st = b.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert st is not None
    assert _cur(st)["id"] == VALID_ID
    # The full activity log delivered on join includes the track_change.
    b.wait_event(2.0)
    assert b.activity_log is not None
    assert any(e["type"] == "track_change" for e in b.activity_log)


# ── QUEUE-13: removeQueued drops a queued item, keeps the rest ──────────────
def test_QUEUE_13_remove_queued_happy_path(make_client):
    third_url = "https://youtu.be/3JZ_D3ELwOQ"
    third_id = "3JZ_D3ELwOQ"
    c = make_client()
    room = room_code()
    c.join(room, role="player")  # player may remove any item
    # A becomes current (auto-start via changeTrack); B and C then queue.
    # playlist = [A, B, C], currentIndex 0, upcoming = [B, C].
    assert c.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    c.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert c.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    assert c.call(ENQUEUE_TRACK, {"url": third_url})["ok"] is True
    seeded = c.wait_for_state(
        lambda s: len(_upcoming(s)) == 2 and _upcoming(s)[1]["id"] == third_id
    )
    cur_idx = seeded["currentIndex"]
    c.states.clear()
    # Remove B at its playlist index (currentIndex + 1).
    ack = c.call(REMOVE_QUEUED, {"index": cur_idx + 1})
    assert ack["ok"] is True
    st = c.wait_for_state(lambda s: len(_upcoming(s)) == 1)
    assert st is not None
    assert len(_upcoming(st)) == 1
    assert _upcoming(st)[0]["id"] == third_id


# ── RMOWN: a controller may remove a queued item it added (ownership) ───────
def test_RMOWN_controller_removes_own(make_client):
    a = make_client()
    player = make_client()
    room = room_code()
    a.join(room, role="controller")
    player.join(room, role="player")
    # Establish a playing current track so the next enqueue queues.
    assert a.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert a.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    st = player.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    assert st is not None
    # The enqueued item is owned by A's socket.
    b_idx = st["currentIndex"] + 1
    assert st["playlist"][b_idx]["ownerId"] == a.sio.get_sid()
    # A removes its own item → ok.
    ack = a.call(REMOVE_QUEUED, {"index": b_idx})
    assert ack["ok"] is True
    st = player.wait_for_state(lambda s: len(_upcoming(s)) == 0)
    assert st is not None


# ── RMOTHER: a different controller cannot remove an item it did not add ─────
def test_RMOTHER_controller_cannot_remove_other(make_client):
    a = make_client()
    b = make_client()
    player = make_client()
    room = room_code()
    a.join(room, role="controller")
    b.join(room, role="controller")
    player.join(room, role="player")
    assert a.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert a.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    st = player.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    b_idx = st["currentIndex"] + 1
    # B did not add it → rejected.
    ack = b.call(REMOVE_QUEUED, {"index": b_idx})
    assert ack["ok"] is False
    assert ack.get("error") == "not your item"


# ── RMPLAYER: the player may remove any queued item (added by a controller) ──
def test_RMPLAYER_player_removes_any(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room, role="controller")
    player.join(room, role="player")
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert controller.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    st = player.wait_for_state(lambda s: any(t["id"] == SECOND_ID for t in _upcoming(s)))
    b_idx = st["currentIndex"] + 1
    # The player (main) may remove any item, even one added by a controller.
    ack = player.call(REMOVE_QUEUED, {"index": b_idx})
    assert ack["ok"] is True
    st = player.wait_for_state(lambda s: len(_upcoming(s)) == 0)
    assert st is not None


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
    observer.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
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


# ── MODE-01: setRepeat broadcasts state.repeat + logs a mode activity ────────
def test_MODE_01_set_repeat_broadcasts_and_logs(make_client):
    player = make_client()
    observer = make_client()
    room = room_code()
    player.join(room, role="player")  # setRepeat is a MAIN action: player-only
    observer.join(room, role="controller")
    observer.states.clear()
    observer.activities.clear()
    ack = player.call(SET_REPEAT, {"mode": "all"})
    assert ack["ok"] is True
    st = observer.wait_for_state(lambda s: s.get("repeat") == "all")
    assert st is not None
    assert st["repeat"] == "all"
    modes = [a for a in observer.activities if a["type"] == "mode"]
    assert modes and modes[-1].get("detail", {}).get("repeat") == "all"


# ── JUMP-01/02/03: jumpTo is player-only, range-checked, sets currentIndex ──
def test_JUMP_01_player_jumps_to_index(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    # Seed playlist [A, B, C], currentIndex 0.
    assert p.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    p.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert p.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    third_url = "https://youtu.be/3JZ_D3ELwOQ"
    third_id = "3JZ_D3ELwOQ"
    assert p.call(ENQUEUE_TRACK, {"url": third_url})["ok"] is True
    p.wait_for_state(lambda s: len(s.get("playlist", [])) == 3)
    p.states.clear()
    p.activities.clear()
    # Player jumps to the last index (C).
    ack = p.call(JUMP_TO, {"index": 2})
    assert ack["ok"] is True
    st = p.wait_for_state(lambda s: s.get("currentIndex") == 2)
    assert st is not None
    assert st["currentIndex"] == 2
    assert _cur(st)["id"] == third_id
    assert st["isPlaying"] is True
    assert any(a["type"] == "track_change" for a in p.activities)


def test_JUMP_02_controller_rejected_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room, role="controller")["ok"] is True
    ack = c.call(JUMP_TO, {"index": 0})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


def test_JUMP_03_out_of_range_rejected(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    assert p.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    p.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    ack = p.call(JUMP_TO, {"index": 9})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid index"


# ── REPEAT-ALL: at-end advance under repeat 'all' wraps to the start ────────
def test_REPEAT_ALL_loops_from_history(make_client):
    controller = make_client()
    player = make_client()
    room = room_code()
    controller.join(room)
    player.join(room, role="player")
    assert player.call(SET_REPEAT, {"mode": "all"})["ok"] is True  # main: player-only
    assert controller.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "A"})["ok"] is True
    player.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert controller.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    # playlist = [A, B], currentIndex 0.

    # First trackEnded advances the cursor to B (last index).
    assert player.call(TRACK_ENDED, {})["ok"] is True
    st = player.wait_for_state(
        lambda s: _cur(s).get("id") == SECOND_ID and len(_upcoming(s)) == 0
    )
    assert st is not None

    # Second trackEnded: at end + repeat 'all' wraps the cursor back to A.
    assert player.call(TRACK_ENDED, {})["ok"] is True
    st = player.wait_for_state(
        lambda s: _cur(s).get("id") == VALID_ID and s.get("isPlaying") is True
    )
    assert st is not None
    assert _cur(st)["id"] == VALID_ID
    assert st["currentIndex"] == 0
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
        lambda s: _cur(s).get("id") == VALID_ID and s.get("isPlaying") is True
    )
    assert player.call(TRACK_ENDED, {})["ok"] is True
    st = player.wait_for_state(
        lambda s: s.get("isPlaying") is False and _cur(s).get("id") == VALID_ID
    )
    assert st is not None
    assert st["isPlaying"] is False
    assert _cur(st)["id"] == VALID_ID


# ── SCHED-xx: weekly play schedule ──────────────────────────────────────────
# NOTE: only the set/validate behaviour is black-box testable here. The
# time-based auto play/stop transitions (SCHED-03/04/05) depend on the SERVER's
# wall clock, which this over-the-wire harness cannot control — they are
# covered by the vitest integration tests (which inject a deterministic `now`
# via the createServer-returned tickSchedules). See docs/qa/schedule.md.

DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def _mon_schedule() -> dict:
    days = {d: {"on": False, "start": "00:00", "end": "23:59"} for d in DAY_KEYS}
    days["mon"] = {"on": True, "start": "09:00", "end": "18:00"}
    return {"enabled": True, "days": days}


# ── SCHED-01: a Player's setSchedule broadcasts state.schedule + logs activity ─
def test_SCHED_01_set_schedule_broadcasts_and_logs(make_client):
    player = make_client()
    observer = make_client()
    room = room_code()
    player.join(room, role="player")
    observer.join(room)
    observer.states.clear()
    observer.activities.clear()
    ack = player.call(SET_SCHEDULE, {"schedule": _mon_schedule()})
    assert ack["ok"] is True
    st = observer.wait_for_state(lambda s: (s.get("schedule") or {}).get("enabled") is True)
    assert st is not None
    assert st["schedule"]["enabled"] is True
    assert any(a["type"] == "schedule" for a in observer.activities)


# ── SCHED-02: invalid schedule from a player (start>end or bad HH:MM) rejected ─
def test_SCHED_02_invalid_schedule_rejected(make_client):
    p = make_client()
    room = room_code()
    p.join(room, role="player")

    bad_range = _mon_schedule()
    bad_range["days"]["mon"] = {"on": True, "start": "18:00", "end": "09:00"}
    ack = p.call(SET_SCHEDULE, {"schedule": bad_range})
    assert ack["ok"] is False
    assert ack.get("error") == "invalid schedule"

    bad_time = _mon_schedule()
    bad_time["days"]["mon"] = {"on": True, "start": "09:00", "end": "25:99"}
    ack2 = p.call(SET_SCHEDULE, {"schedule": bad_time})
    assert ack2["ok"] is False
    assert ack2.get("error") == "invalid schedule"


# ── SCHED-06: setSchedule is player only (controller rejected) ──────────────
def test_SCHED_06_set_schedule_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    ack = c.call(SET_SCHEDULE, {"schedule": _mon_schedule()})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


VALID_URL2 = "https://youtu.be/9bZkp7q19f0"
VALID_ID2 = "9bZkp7q19f0"


# ── DEQ-01: dequeue activity records WHICH track was removed (title/id) ──────
def test_DEQ_01_dequeue_detail_has_track(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room, role="player")["ok"] is True  # player may remove any item
    # First enqueue auto-starts (current); the second sits upcoming.
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL2})["ok"] is True
    c.wait_for_state(lambda s: len(_upcoming(s)) >= 1)
    c.activities.clear()
    # Remove the upcoming one at its playlist index (currentIndex + 1).
    st = c.last_state()
    assert st is not None and len(_upcoming(st)) >= 1
    ack = c.call(REMOVE_QUEUED, {"index": st["currentIndex"] + 1})
    assert ack["ok"] is True
    c.wait_event(3.0)
    dq = [a for a in c.activities if a["type"] == "dequeue"]
    assert dq, "expected a dequeue activity"
    assert "id" in (dq[-1].get("detail") or {})


# ── SHUF: one-shot queue shuffle (shuffleQueue) ────────────────────────────
def _ids(n: int) -> list[str]:
    base = "abcdefghijkmnpqrstuvwxyz0123456789"
    return ["".join(base[(i * 7 + j) % len(base)] for j in range(11)) for i in range(n)]


def _seed_queue(player, room: str, ids: list[str]) -> None:
    """Play the first id (current), enqueue the rest so they sit upcoming.

    FAKE_TITLE makes the embeddable check pass without network for any url.
    """
    first, *rest = ids
    assert player.call(CHANGE_TRACK, {"url": f"https://youtu.be/{first}", "reason": "현재"})["ok"]
    for vid in rest:
        assert player.call(ENQUEUE_TRACK, {"url": f"https://youtu.be/{vid}"})["ok"]
    player.wait_for_state(lambda s: len(_upcoming(s)) >= len(rest))


# ── SHUF-01: shuffleQueue is player only (controller rejected) ─────────────
def test_SHUF_01_shuffle_queue_player_only(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    ack = c.call(SHUFFLE_QUEUE, {})
    assert ack["ok"] is False
    assert ack.get("error") == "player only"


# ── SHUF-02: shuffle preserves played+current prefix + the upcoming SET ─────
def test_SHUF_02_shuffle_preserves_set_and_current(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    ids = _ids(6)
    _seed_queue(p, room, ids)

    before = p.last_state()
    cur_idx = before["currentIndex"]
    # Prefix = everything up to and including the current track (played + current).
    prefix_before = [t["id"] for t in before["playlist"][: cur_idx + 1]]
    upcoming_before = sorted(t["id"] for t in _upcoming(before))

    p.states.clear()
    assert p.call(SHUFFLE_QUEUE, {})["ok"] is True
    after = p.wait_for_state(lambda s: any(a["type"] == "mode" for a in p.activities) or True)
    after = p.last_state()
    after_cur_idx = after["currentIndex"]
    prefix_after = [t["id"] for t in after["playlist"][: after_cur_idx + 1]]
    # The played+current prefix is untouched (same ids, same order, same cursor).
    assert after_cur_idx == cur_idx
    assert prefix_after == prefix_before
    # The upcoming set is preserved (only reordered).
    assert sorted(t["id"] for t in _upcoming(after)) == upcoming_before


# ── SHUF-03: shuffling with <2 upcoming is a harmless no-op ack ─────────────
def test_SHUF_03_shuffle_short_queue_noop(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    # No current, nothing upcoming.
    assert p.call(SHUFFLE_QUEUE, {})["ok"] is True


# ── ENQTITLE: enqueue activity title is backfilled once YouTube resolves it ──
def test_ENQTITLE_activity_title_backfilled(make_client):
    c = make_client()
    room = room_code()
    assert c.join(room)["ok"] is True
    # No title supplied → enqueue logs title:null, then enrichTitle backfills it
    # (FAKE_TITLE='QA Title') and re-emits the full activity log.
    assert c.call(ENQUEUE_TRACK, {"url": VALID_URL})["ok"] is True
    deadline = time.monotonic() + 4.0
    found = None
    while time.monotonic() < deadline:
        for e in c.activity_log or []:
            if e.get("type") == "enqueue" and (e.get("detail") or {}).get("title") == "QA Title":
                found = e
                break
        if found:
            break
        c.wait_event(1.0)
    assert found is not None, "enqueue activity title should backfill to 'QA Title'"


# ── ERRBLOCK: embed error blocklists the video (auto-skip + re-add blocked) ──
def test_ERRBLOCK_embed_error_blocks_and_skips(make_client):
    p = make_client()
    room = room_code()
    assert p.join(room, role="player")["ok"] is True
    # A becomes current; B is appended after it.
    assert p.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "a"})["ok"] is True
    p.wait_for_state(lambda s: _cur(s).get("id") == VALID_ID)
    assert p.call(ENQUEUE_TRACK, {"url": SECOND_URL})["ok"] is True
    p.wait_for_state(lambda s: SECOND_ID in [t["id"] for t in (s.get("playlist") or [])])

    # Player reports an embed-disabled error (150) for the current track A →
    # A is blocklisted and the cursor advances to B.
    p.states.clear()
    assert p.call(PLAYBACK_ERROR, {"code": 150, "id": VALID_ID})["ok"] is True
    assert p.wait_for_state(lambda s: _cur(s).get("id") == SECOND_ID) is not None

    # Re-adding A is now rejected at the controller (per-room blocklist).
    ack = p.call(CHANGE_TRACK, {"url": VALID_URL, "reason": "again"})
    assert ack["ok"] is False and ack.get("error") == "embed disabled"
    ack2 = p.call(ENQUEUE_TRACK, {"url": VALID_URL})
    assert ack2["ok"] is False and ack2.get("error") == "embed disabled"
