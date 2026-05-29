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
    w.__ytCalls = { loadVideoById: [], setVolume: [], playVideo: 0, pauseVideo: 0 };
    class FakePlayer {
      constructor(_el: HTMLElement, opts: { events?: { onReady?: () => void } }) {
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
    }
    w.YT = { Player: FakePlayer };
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
