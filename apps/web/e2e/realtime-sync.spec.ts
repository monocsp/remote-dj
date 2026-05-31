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
      constructor(
        _el: HTMLElement,
        opts: { events?: { onReady?: () => void; onError?: (e: { data: number }) => void } },
      ) {
        // Let tests drive a YouTube error event from the page context.
        w.__ytFireError = (code: number) => opts?.events?.onError?.({ data: code });
        // Signal ready on next tick so the page wires up state effects.
        setTimeout(() => opts?.events?.onReady?.(), 0);
      }
      loadVideoById(id: string) {
        w.__ytCalls.loadVideoById.push(id);
      }
      setVolume(v: number) {
        w.__ytCalls.setVolume.push(v);
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
  const page = await context.newPage();
  const q = nick ? `&nick=${encodeURIComponent(nick)}` : '';
  await page.goto(`/${role}?room=${room}${q}`);
  // Generous timeout absorbs Next dev's on-demand route compile on first hit.
  await expect(page.getByText('연결됨')).toBeVisible({ timeout: 30_000 });
  return page;
}

async function changeTrack(page: Page, url: string, reason: string): Promise<void> {
  // Scope to the 곡 변경 section — the 대기열 section has its own URL input.
  const section = page.locator('section', { hasText: '곡 변경' });
  await section.getByPlaceholder('YouTube URL').fill(url);
  await section.getByPlaceholder('사유 (필수)').fill(reason);
  await section.getByRole('button', { name: '곡 변경' }).click();
}

// RT-01 + TRK-06: a track change by Controller A reaches Controller B's UI and
// the Player's mocked YouTube player.
test('RT-01/TRK-06 multi-controller sync + player playback', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  await mockYouTube(playerCtx);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');
  const b = await openRoom(ctxB, 'controller', room, 'B');

  // Controller A changes the track with a required reason.
  await changeTrack(a, VALID_URL, '분위기 띄우려고');

  // RT-01: Controller B's now-playing reflects the new track URL.
  await expect(b.getByRole('link', { name: VALID_URL })).toBeVisible({ timeout: 15_000 });

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

async function enqueueTrack(page: Page, url: string): Promise<void> {
  const queueSection = page.locator('section', { hasText: '대기열' });
  await queueSection.getByPlaceholder('YouTube URL').fill(url);
  await queueSection.getByRole('button', { name: '대기열 추가' }).click();
}

// QUEUE-01 + QUEUE-07: Controller A enqueues a valid track → it appears in
// Controller B's queue UI; A clicks 다음 곡 → the formerly-queued track becomes
// the now-playing track on both controllers.
test('QUEUE-01/07 enqueue propagates + 다음 곡 promotes to now-playing', async ({ browser }) => {
  const room = uniqueRoom();

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const a = await openRoom(ctxA, 'controller', room, 'A');
  const b = await openRoom(ctxB, 'controller', room, 'B');

  // QUEUE-01: A enqueues a valid track (no reason required for enqueue).
  await enqueueTrack(a, VALID_URL);

  // The enqueued URL shows up in Controller B's queue list.
  const bQueue = b.locator('section', { hasText: '대기열' });
  await expect(bQueue.getByText(VALID_URL)).toBeVisible({ timeout: 15_000 });

  // QUEUE-07: A clicks 다음 곡 → head promotes to currentTrack.
  await a.getByRole('button', { name: '다음 곡' }).click();

  // Both controllers' now-playing card reflects the formerly-queued track.
  await expect(a.getByRole('link', { name: VALID_URL })).toBeVisible({ timeout: 15_000 });
  await expect(b.getByRole('link', { name: VALID_URL })).toBeVisible({ timeout: 15_000 });

  await Promise.all([ctxA.close(), ctxB.close()]);
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

// SEEK-06/01 (web slice): a mocked Player reports progress so the Controller's
// 탐색 bar appears, and a Controller seek is accepted and logged. The server-side
// propagation of lastSeek to other clients + the Player applying it are covered
// reliably by the server observer test (server.test.ts) and the Python harness;
// here we verify the web UI path (progress → bar → seek → activity).
test('SEEK-06/01 progress shows seek bar + controller seek is logged', async ({ browser }) => {
  const room = uniqueRoom();

  const playerCtx = await browser.newContext();
  await mockYouTube(playerCtx);
  const ctxA = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');

  // Load + start a track so the Player begins reporting progress (~2s interval).
  await changeTrack(a, VALID_URL, '탐색 테스트');

  // Player recorded the load (track is now playing).
  await expect
    .poll(
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      async () => player.evaluate(() => (window as any).__ytCalls?.loadVideoById ?? []),
      { timeout: 15_000 },
    )
    .toContain(VALID_ID);

  // SEEK-06: progress propagates → Controller's 탐색 range input appears.
  const seekSection = a.locator('section', { hasText: '탐색' });
  const seekRange = seekSection.locator('input[type="range"]').first();
  await expect(seekRange).toBeVisible({ timeout: 20_000 });

  // SEEK-01: a real pointer gesture on the slider issues a seek; the controller's
  // own Activity Log then shows the seek entry (UI → server path).
  await seekRange.click();
  await expect(a.locator('section', { hasText: 'Activity Log' }).getByText('탐색')).toBeVisible({
    timeout: 10_000,
  });

  await Promise.all([playerCtx.close(), ctxA.close()]);
});

// SET-01: Controller A toggles allowAnonymous off → Controller B's settings UI
// reflects it (checkbox becomes unchecked + the nickname hint appears). Verifies
// updateSettings broadcasts and the controller settings UI renders state.
test('SET-01 allowAnonymous toggle syncs to other controller UI', async ({ browser }) => {
  const room = uniqueRoom();

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const a = await openRoom(ctxA, 'controller', room, 'A');
  const b = await openRoom(ctxB, 'controller', room, 'B');

  const checkboxA = a.getByRole('checkbox', { name: /익명 허용/ });
  const checkboxB = b.getByRole('checkbox', { name: /익명 허용/ });

  // Default allowAnonymous=true → both controllers show the box checked.
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
  await mockYouTube(playerCtx);
  const ctxA = await browser.newContext();

  const player = await openRoom(playerCtx, 'player', room);
  const a = await openRoom(ctxA, 'controller', room, 'A');

  // Load a track so there's a now-playing context.
  await changeTrack(a, VALID_URL, '오류 테스트');
  await expect(a.getByRole('link', { name: VALID_URL })).toBeVisible({ timeout: 15_000 });

  // Fire a YouTube error (100 = not found) from the mocked Player.
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  await player.evaluate(() => (window as any).__ytFireError(100));

  // The Controller surfaces the error indicator.
  await expect(a.getByText(/재생 오류/)).toBeVisible({ timeout: 15_000 });

  await Promise.all([playerCtx.close(), ctxA.close()]);
});
