"""Load the exported protocol contract (qa/contract.json).

The Python black-box harness deliberately does NOT import any TypeScript from
@remote-dj/shared — that physical separation prevents the tester from drifting
toward the implementation. Instead it reads event names and limits from the
JSON snapshot produced by `npm run contract:export`.

If the snapshot is stale relative to the running server, tests fail — which is
itself a useful drift signal.
"""

from __future__ import annotations

import json
from pathlib import Path

# qa/server/contract.py -> qa/contract.json
_CONTRACT_PATH = Path(__file__).resolve().parent.parent / "contract.json"


def _load() -> dict:
    with _CONTRACT_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


_CONTRACT = _load()

C2S: dict[str, str] = _CONTRACT["c2s"]
S2C: dict[str, str] = _CONTRACT["s2c"]
LIMITS: dict[str, int] = _CONTRACT["limits"]

# Convenience event-name constants (raw wire strings, not TS imports).
JOIN = C2S["Join"]
CHANGE_TRACK = C2S["ChangeTrack"]
SET_VOLUME = C2S["SetVolume"]
TOGGLE_PLAY = C2S["TogglePlay"]
UPDATE_SETTINGS = C2S["UpdateSettings"]
ENQUEUE_TRACK = C2S["EnqueueTrack"]
REMOVE_QUEUED = C2S["RemoveQueued"]
NEXT_TRACK = C2S["NextTrack"]
TRACK_ENDED = C2S["TrackEnded"]
SEEK_TO = C2S["SeekTo"]
PROGRESS = C2S["Progress"]
PLAYBACK_ERROR = C2S["PlaybackError"]
SET_TRACK_GAIN = C2S["SetTrackGain"]
SET_REPEAT = C2S["SetRepeat"]
SET_SCHEDULE = C2S["SetSchedule"]
JUMP_TO = C2S["JumpTo"]
SHUFFLE_QUEUE = C2S["ShuffleQueue"]

EV_STATE = S2C["State"]
EV_ACTIVITY = S2C["Activity"]
EV_ACTIVITY_LOG = S2C["ActivityLog"]
