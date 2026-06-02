import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { io as ioClient } from 'socket.io-client';

// Black-box web E2E. These tests drive the running app via the browser only and
// assert against docs/qa/*.md scenarios. They MUST NOT encode expectations from
// app source — only from the QA acceptance docs.
//
// Covered scenario IDs:
//   RT-01  multi-controller sync (track change propagates A → B)
//   TRK-06 track change updates Player's YouTube playback (loadVideoById)
//   PAIR-01/07 pairing happy-path (join → connected)
//   PAIR-06 wrong-password rejection (room stays gated)
//   QUEUE-01/07 enqueue propagates A → B; 다음 곡 promotes head to now-playing
//
// The YouTube IFrame API is mocked so no real network/login is needed: we
// intercept the iframe_api script and inject a window.YT stub that records
// loadVideoById / setVolume / playVideo / pauseVideo onto window.__ytCalls.

const VALID_URL = 'https://youtu.be/dQw4w9WgXcQ';
const VALID_ID = 'dQw4w9WgXcQ';

function uniqueRoom(): string {
  // 6-char uppercase from the confusion-free charset (SPEC §pairing).
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += charset[Math.floor(Math.random() * charset.length)];
  return code;
}

/** Install a YouTube IFrame API mock that records player calls. */
async function mockYouTube(context: BrowserContext): Promise<void> {
  // Stub window.YT before any page script runs.
  await context.addInitScript(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const w = window as any;
    w.__ytCalls = {
      loadVideoById: [],
      setVolume: [],
      playVideo: 0,
      pauseVideo: 0,
      seekTo: [],
    };
    // Stored playback position the Player reports as progress.
    w.__ytTime = 12;
    class FakePlayer {
      _muted = false;
      constructor(
        _el: HTMLElement,
        opts: {
          events?: {
            onReady?: () => void;
            onStateChange?: (e: { data: number }) => void;
            onError?: (e: { data: number }) => void;
          };
        },
      ) {
        // Let tests drive a YouTube error event from the page context.
        w.__ytFireError = (code: number) => opts?.events?.onError?.({ data: code });
        // Signal ready, then fire PLAYING — lets the headless embed preflight
        // (lib/embedCheck) resolve 'ok' so enqueue proceeds in tests.
        setTimeout(() => {
          opts?.events?.onReady?.();
          opts?.events?.onStateChange?.({ data: 1 }); // 1 = PlayerState.PLAYING
        }, 0);
      }
      loadVideoById(id: string) {
        w.__ytCalls.loadVideoById.push(id);
      }
      setVolume(v: number) {
        w.__ytCalls.setVolume.push(v);
      }
      // Mirror the real IFrame mute API the Player now reconciles on volume.
      isMuted() {
        return this._muted;
      }
      mute() {
        this._muted = true;
      }
      unMute() {
        this._muted = false;
      }
      playVideo() {
        w.__ytCalls.playVideo += 1;
      }
      pauseVideo() {
        w.__ytCalls.pauseVideo += 1;
      }
      getCurrentTime() {
        return w.__ytTime;
      }
      getDuration() {
        return 100;
      }
      seekTo(sec: number, allow: boolean) {
        w.__ytCalls.seekTo.push({ sec, allow });
        w.__ytTime = sec;
      }
    }
    w.YT = { Player: FakePlayer, PlayerState: { ENDED: 0, PLAYING: 1 } };
  });

  // Neutralize the real IFrame API script and immediately fire the ready hook.
  await context.route('**/iframe_api', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();',
    });
  });
}

/** Join a room as the given role via URL params (Landing routes to these). */
async function openRoom(
  context: BrowserContext,
  role: 'player' | 'controller',
  room: string,
  nick?: string,
): Promise<Page> {
  // Mock YouTube on EVERY context — controllers now run a headless embed
  // preflight (lib/embedCheck) on enqueue, which needs window.YT too.
  await mockYouTube(context);
  const page = await context.newPage();
  const q = nick ? `&nick=${encodeURIComponent(nick)}` : '';
  await page.goto(`/${role}?room=${room}${q}`);
  // Generous timeout absorbs Next dev's on-demand route compile on first hit.
  await expect(page.getByText('연결됨')).toBeVisible({ timeout: 30_000 });
  return page;
}

// RT-01 + TRK-06: enqueuing into an idle room auto-starts the track as the
// current track (곡 변경 was removed); that reaches Controller B's UI and the
// Player's mocked YouTube player.
test('RT-01/TRK-06 multi-controller sync + player playback', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');
  const b = await openRoom(ctxB, 'controller', room, 'B');

  // Controller A enqueues into the idle room → it auto-starts as currentTrack.
  await enqueueTrack(a, VALID_URL);

  // RT-01: Controller A's AND B's now-playing reflect the new track URL.
  await expect(currentRow(a, VALID_ID)).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(b, VALID_ID)).toBeVisible({ timeout: 15_000 });

  // TRK-06: Player recorded loadVideoById with the parsed video id.
  await expect
    .poll(
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      async () => player.evaluate(() => (window as any).__ytCalls?.loadVideoById ?? []),
      { timeout: 15_000 },
    )
    .toContain(VALID_ID);

  await Promise.all([playerCtx.close(), ctxA.close(), ctxB.close()]);
});

// Enqueue is now URL-only (no reason/title — the server auto-fills the title).
// The enqueue form lives in the 재생목록 section.
async function enqueueTrack(page: Page, url: string): Promise<void> {
  const section = page.locator('section', { hasText: '재생목록' });
  await section.getByPlaceholder('YouTube URL').fill(url);
  await section.getByRole('button', { name: '대기열에 추가' }).click();
}

// Locate a playlist row by its video id. Rows show thumbnail + title (no raw
// URL), so we key on data-testid + data-id.
function queueRow(page: Page, id: string) {
  return page.locator(`[data-testid="queue-item"][data-id="${id}"]`);
}

// Locate the CURRENT (now-playing) row by id — the unified playlist marks it
// with data-state="current" (replaces the old now-playing URL link).
function currentRow(page: Page, id: string) {
  return page.locator(`[data-testid="queue-item"][data-state="current"][data-id="${id}"]`);
}

const SECOND_URL = 'https://youtu.be/9bZkp7q19f0';
const SECOND_ID = '9bZkp7q19f0';

// QUEUE-01 + QUEUE-07: with a track already playing, Controller A enqueues a
// valid track → it appears in Controller B's queue UI; the PLAYER (main) clicks
// 다음 곡 (a main-only action) → the formerly-queued track becomes the
// now-playing track on the controllers.
// NOTE: enqueuing into an IDLE room auto-starts the track (QUEUE-14), so to test
// QUEUEING we first change the current track, then enqueue B.
test('QUEUE-01/07 enqueue propagates + 다음 곡 promotes to now-playing', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');
  const b = await openRoom(ctxB, 'controller', room, 'B');

  // Establish a playing current track first (idle enqueue auto-starts) so the
  // NEXT enqueue queues instead of auto-starting.
  await enqueueTrack(a, VALID_URL);
  await expect(currentRow(a, VALID_ID)).toBeVisible({ timeout: 15_000 });

  // QUEUE-01: A enqueues a second valid track (no reason required for enqueue).
  await enqueueTrack(a, SECOND_URL);

  // The enqueued track shows up in Controller B's queue list (located by id —
  // the YouTube-style row no longer renders the raw URL).
  await expect(queueRow(b, SECOND_ID)).toBeVisible({ timeout: 15_000 });

  // QUEUE-07: the PLAYER clicks 다음 곡 (main-only) → queued head promotes.
  await player.getByRole('button', { name: '다음 곡', exact: true }).click();

  // Both controllers' now-playing card reflects the formerly-queued track.
  await expect(currentRow(a, SECOND_ID)).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(b, SECOND_ID)).toBeVisible({ timeout: 15_000 });

  await Promise.all([playerCtx.close(), ctxA.close(), ctxB.close()]);
});

// PAIR-01/07: pairing happy-path — a controller joining an open room connects
// and can immediately operate (no password gate).
test('PAIR-01/07 pairing happy-path', async ({ browser }) => {
  const room = uniqueRoom();
  const ctx = await browser.newContext();
  const page = await openRoom(ctx, 'controller', room, '철수');

  // Connected state proves join succeeded and state/activityLog were received.
  await expect(page.getByText('연결됨')).toBeVisible();
  await expect(page.getByText(room)).toBeVisible();

  await ctx.close();
});

// PAIR-06: wrong password is rejected. We exercise the join/password contract
// directly at the socket layer (faster + deterministic than driving the Landing
// password UI): first socket creates a password-gated room, a second socket
// joins with a wrong password and must be rejected.
test('PAIR-06 wrong-password rejection (contract via socket)', async () => {
  const room = uniqueRoom();

  // Raw socket join from Node (no browser) — exercises the join/password
  // contract directly against the server on :3001.
  async function rawJoin(password: string): Promise<{ ok: boolean; error?: string }> {
    const s = ioClient('http://localhost:3001', {
      transports: ['websocket'],
      forceNew: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        s.on('connect', () => resolve());
        s.on('connect_error', (e) => reject(e));
        setTimeout(() => reject(new Error('connect timeout')), 8000);
      });
      return (await s.emitWithAck('join', {
        roomCode: room,
        role: 'controller',
        password,
      })) as { ok: boolean; error?: string };
    } finally {
      s.disconnect();
    }
  }

  // Create gated room.
  const created = await rawJoin('secret');
  expect(created.ok).toBe(true);

  // Wrong password is rejected.
  const wrong = await rawJoin('nope');
  expect(wrong.ok).toBe(false);
  expect(wrong.error).toBe('wrong password');
});

// NOTE: the 탐색(seek) slider UI was removed from the Player, so its web E2E was
// dropped. The seekTo protocol itself stays covered by the Python harness.

// SET-01: the settings(설정) UI is now a MAIN-only control on the Player. A
// Player toggles allowAnonymous off → a second Player's settings UI reflects it
// (checkbox becomes unchecked + the nickname hint appears). Verifies
// updateSettings broadcasts and the player settings UI renders state.
test('SET-01 allowAnonymous toggle syncs to other player UI', async ({ browser }) => {
  const room = uniqueRoom();

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const a = await openRoom(ctxA, 'player', room);
  const b = await openRoom(ctxB, 'player', room);

  const checkboxA = a.getByRole('checkbox', { name: /익명 허용/ });
  const checkboxB = b.getByRole('checkbox', { name: /익명 허용/ });

  // Default allowAnonymous=true → both players show the box checked.
  await expect(checkboxA).toBeChecked({ timeout: 15_000 });
  await expect(checkboxB).toBeChecked({ timeout: 15_000 });

  // A turns anonymity off.
  await checkboxA.uncheck();

  // B's UI reflects it: box unchecked + hint visible.
  await expect(checkboxB).not.toBeChecked({ timeout: 15_000 });
  await expect(b.getByText('닉네임이 있어야 곡을 변경할 수 있어요')).toBeVisible({
    timeout: 15_000,
  });

  await Promise.all([ctxA.close(), ctxB.close()]);
});

// ERR-01: a mocked Player fires a YouTube playback error → the Controller shows
// the 재생 오류 indicator near now-playing. Drives the full player → server →
// controller path via the browser only.
test('ERR-01 player playback error surfaces on the controller', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  const ctxA = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');

  // Load a track so there's a now-playing context (idle enqueue auto-starts).
  await enqueueTrack(a, VALID_URL);
  await expect(currentRow(a, VALID_ID)).toBeVisible({ timeout: 15_000 });

  // Fire a YouTube error (100 = not found) from the mocked Player.
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  await player.evaluate(() => (window as any).__ytFireError(100));

  // The Controller surfaces the error indicator.
  await expect(a.getByText(/재생 오류/)).toBeVisible({ timeout: 15_000 });

  await Promise.all([playerCtx.close(), ctxA.close()]);
});

// QUEUE-REMOVE (guest ownership): a guest sees a remove ✕ ONLY on the item it
// added and removing it succeeds; it sees NO ✕ on another guest's item.
test('QUEUE-REMOVE guest can remove only its own queued item', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');
  const b = await openRoom(ctxB, 'controller', room, 'B');

  // Start a current track (idle enqueue auto-starts) so the next enqueue queues.
  await enqueueTrack(a, VALID_URL);
  await expect(currentRow(a, VALID_ID)).toBeVisible({ timeout: 15_000 });

  // Guest A enqueues SECOND track → it queues and A owns it.
  await enqueueTrack(a, SECOND_URL);
  await expect(queueRow(a, SECOND_ID)).toBeVisible({ timeout: 15_000 });
  await expect(queueRow(b, SECOND_ID)).toBeVisible({ timeout: 15_000 });

  // A sees its own remove ✕; B sees the same row but NO remove ✕ (not its item).
  await expect(queueRow(a, SECOND_ID).getByRole('button', { name: '제거' })).toBeVisible();
  await expect(queueRow(b, SECOND_ID).getByRole('button', { name: '제거' })).toHaveCount(0);

  // A removes its own item → confirm the dialog → it disappears for both A and B.
  await queueRow(a, SECOND_ID).getByRole('button', { name: '제거' }).click();
  await a.getByTestId('remove-confirm-ok').click();
  await expect(queueRow(a, SECOND_ID)).toHaveCount(0, { timeout: 15_000 });
  await expect(queueRow(b, SECOND_ID)).toHaveCount(0, { timeout: 15_000 });

  await Promise.all([playerCtx.close(), ctxA.close(), ctxB.close()]);
});

// QUEUE-REMOVE (main): the Player (main) may remove ANY queued item, including
// one a guest added.
test('QUEUE-REMOVE main can remove any queued item', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  const ctxA = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');

  await enqueueTrack(a, VALID_URL);
  await expect(currentRow(a, VALID_ID)).toBeVisible({ timeout: 15_000 });

  // Guest A enqueues a track the Player (main) will remove.
  await enqueueTrack(a, SECOND_URL);
  await expect(queueRow(player, SECOND_ID)).toBeVisible({ timeout: 15_000 });

  // Player sees a remove ✕ on the guest's item; confirm the dialog → it's removed.
  await queueRow(player, SECOND_ID).getByRole('button', { name: '제거' }).click();
  await player.getByTestId('remove-confirm-ok').click();
  await expect(queueRow(player, SECOND_ID)).toHaveCount(0, { timeout: 15_000 });
  await expect(queueRow(a, SECOND_ID)).toHaveCount(0, { timeout: 15_000 });

  await Promise.all([playerCtx.close(), ctxA.close()]);
});
