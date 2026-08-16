import { useEffect, useRef, useState } from "react";
import { loadYouTubeApi } from "./youtubeLoader";
import { markWatched } from "../../api/learner";
import { IconButton, Spinner, Alert } from "../../components/ui";
import styles from "./YouTubePlayer.module.css";

const API_LOAD_TIMEOUT_MS = 12000;

// YT.Player onError codes: 2 = invalid videoId, 5 = HTML5 player error,
// 100 = video removed/private, 101/150 = embedding disabled by the video's
// owner. All four mean "this specific video will never play here", so they
// share one message rather than trying to explain the YouTube-specific code.
const YT_ERROR_MESSAGE = "This video can't be played here — it may be private, removed, or its owner has disabled embedding. Let your instructor know.";

function fmtTime(s) {
  s = Math.floor(s);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/**
 * Faithful port of legacy dashboard.html's video player (openLesson /
 * loadYouTube / onYTStateChange / pollProgress — see Phase 10 analysis):
 * the server is authoritative on watched time, not the browser — this
 * component clamps playback to `maxWatchedSec` (seeking back if the
 * viewer tries to skip ahead), polls every 500ms while playing, and saves
 * via markWatched() every ~3s (6 ticks) and again on pause/end. Nothing
 * about completion is decided client-side; the backend independently
 * clamps and validates every reported value (see api/learner.js).
 *
 * Bug fix ("clicking Play does nothing"): the legacy port had no ready/
 * error/loading state at all — the Play button was clickable the instant
 * this component mounted, but `togglePlay` silently no-ops
 * (`if (!player) return;`) until the async YouTube iframe API script has
 * actually loaded and `onReady` has fired. On a slow connection, or when
 * a school/home network blocks youtube.com outright (a real possibility
 * for a kids' platform), that gap could be several seconds or forever —
 * and a learner clicking Play during it saw literally no feedback, which
 * looks exactly like "the video doesn't play." This adds an explicit
 * ready state (Play is disabled with a spinner until the player is
 * actually ready), a timeout that surfaces a clear error if the API
 * script never loads, and an onError handler for YouTube-side failures
 * (video private/removed, or embedding disabled by its owner) — all of
 * these previously failed completely silently.
 *
 * Also now embeds via youtube-nocookie.com and adds a click-shield
 * overlay in front of the iframe (see the .clickShield div below) so a
 * learner can't reach YouTube's own right-click "Watch on YouTube" menu,
 * its logo watermark, or double-click-to-fullscreen — every interaction
 * with the video is forced through our own Play/Pause button instead.
 */
export default function YouTubePlayer({ userId, moduleId, lesson, initialWatchedSec, onProgressSaved }) {
  const holderRef = useRef(null);
  const playerRef = useRef(null);
  const maxWatchedRef = useRef(initialWatchedSec || 0);
  const ticksSinceSaveRef = useRef(0);
  const pollTimerRef = useRef(null);
  const timeoutRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(initialWatchedSec || 0);
  const [playerReady, setPlayerReady] = useState(false);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    maxWatchedRef.current = initialWatchedSec || 0;
    setDisplayTime(initialWatchedSec || 0);
    setPlayerReady(false);
    setLoadError(null);

    timeoutRef.current = setTimeout(() => {
      if (!cancelled && !playerRef.current) {
        setLoadError("Couldn't load the video player. Check your internet connection, or that YouTube isn't blocked on this network, then try again.");
      }
    }, API_LOAD_TIMEOUT_MS);

    loadYouTubeApi().then((YT) => {
      if (cancelled || !holderRef.current) return;
      playerRef.current = new YT.Player(holderRef.current, {
        videoId: lesson.youtubeId,
        host: "https://www.youtube-nocookie.com",
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, iv_load_policy: 3 },
        events: {
          onReady: () => {
            clearTimeout(timeoutRef.current);
            if (cancelled) return;
            setPlayerReady(true);
            if (maxWatchedRef.current > 0) {
              playerRef.current.seekTo(Math.min(maxWatchedRef.current, lesson.durationSec - 2), true);
            }
          },
          onStateChange: onStateChange,
          onError: () => {
            clearTimeout(timeoutRef.current);
            if (!cancelled) setLoadError(YT_ERROR_MESSAGE);
          },
        },
      });
    });

    function onStateChange(e) {
      if (e.data === 1) {
        // playing
        setPlaying(true);
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(pollProgress, 500);
        return;
      }
      setPlaying(false);
      clearInterval(pollTimerRef.current);
      // Bug fix ("clicking Play refreshes and stops without playing"):
      // this used to fire markWatched()/onProgressSaved() for *any*
      // non-playing state, including the normal, transient buffering
      // state (3) YouTube fires immediately after every single
      // playVideo() call, before actual playback starts — as well as
      // cued (5) and unstarted (-1). onProgressSaved is wired to
      // LessonPage's reload(), which flips the whole page into a
      // loading skeleton (see useModuleLessons.js's own fix), which
      // unmounts this exact component and destroys the YT.Player
      // instance mid-buffer. So clicking Play reliably nuked itself
      // before the video ever actually started. Only state 2 (an
      // actual, deliberate pause) and state 0 (ended, handled
      // separately below) represent the learner genuinely stopping —
      // buffering/cued/unstarted are just player-internal transitions
      // and shouldn't trigger a save or a reload at all.
      if (e.data === 2) {
        markWatched(userId, moduleId, lesson.id, maxWatchedRef.current).then((res) => onProgressSaved?.(maxWatchedRef.current, res.complete));
      }
      if (e.data === 0) {
        // ended
        maxWatchedRef.current = lesson.durationSec;
        setDisplayTime(lesson.durationSec);
        markWatched(userId, moduleId, lesson.id, maxWatchedRef.current).then((res) => onProgressSaved?.(maxWatchedRef.current, res.complete));
      }
    }

    function pollProgress() {
      const player = playerRef.current;
      if (!player || !player.getCurrentTime) return;
      const t = player.getCurrentTime();
      if (t > maxWatchedRef.current + 2.5) {
        player.seekTo(maxWatchedRef.current, true);
        return;
      }
      maxWatchedRef.current = Math.max(maxWatchedRef.current, t);
      setDisplayTime(maxWatchedRef.current);
      ticksSinceSaveRef.current++;
      if (ticksSinceSaveRef.current >= 6) {
        ticksSinceSaveRef.current = 0;
        markWatched(userId, moduleId, lesson.id, maxWatchedRef.current).then((res) => onProgressSaved?.(maxWatchedRef.current, res.complete));
      }
    }

    return () => {
      cancelled = true;
      clearTimeout(timeoutRef.current);
      clearInterval(pollTimerRef.current);
      if (playerRef.current && playerRef.current.destroy) playerRef.current.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.id]);

  function togglePlay() {
    const player = playerRef.current;
    if (!player || !playerReady) return;
    if (playing) player.pauseVideo();
    else player.playVideo();
  }

  const pct = Math.min(100, (displayTime / lesson.durationSec) * 100);

  return (
    <div className={styles.shell}>
      <div className={styles.frameWrap}>
        <div ref={holderRef} className={styles.frame} />
        {/* Click-shield: sits on top of the YouTube iframe so every click
            is forced through our own controls instead of YouTube's own
            (hidden but still technically present) UI — its right-click
            "Watch on YouTube" menu item, logo watermark, and
            double-click-to-fullscreen escape hatch are all unreachable
            through this. A left-click still toggles play/pause, so it
            doesn't remove any functionality a learner actually needs. */}
        {!loadError && (
          <div
            className={styles.clickShield}
            onClick={togglePlay}
            onDoubleClick={(e) => e.preventDefault()}
            onContextMenu={(e) => e.preventDefault()}
            role="presentation"
          />
        )}
        {!playerReady && !loadError && (
          <div className={styles.overlay}>
            <Spinner size="lg" />
            <span>Loading video…</span>
          </div>
        )}
        {loadError && (
          <div className={styles.overlay}>
            <Alert variant="danger">{loadError}</Alert>
          </div>
        )}
      </div>
      <div className={styles.controls}>
        <IconButton label={playing ? "Pause" : "Play"} onClick={togglePlay} variant="solid" disabled={!playerReady || !!loadError}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="2" width="4" height="12" fill="currentColor" />
              <rect x="9" y="2" width="4" height="12" fill="currentColor" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2l10 6-10 6V2z" fill="currentColor" />
            </svg>
          )}
        </IconButton>
        <div className={styles.seek}>
          <div className={styles.watched} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.timeLabel}>
          {fmtTime(displayTime)} / {fmtTime(lesson.durationSec)}
        </span>
      </div>
      <p className={styles.lockNote}>🔒 Skipping ahead is disabled — the next lesson unlocks once you finish this video and pass its quiz.</p>
    </div>
  );
}
