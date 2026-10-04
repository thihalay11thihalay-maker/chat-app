/**
 * Seconds written the way a player writes a running time.
 *
 * `m:ss` covers a voice message and a short clip, which is nearly everything this app plays, and
 * `h:mm:ss` only past the hour because that is a different kind of thing to read. The seconds are
 * padded to two digits so the label keeps its width as it counts: a clock that goes from `0:9` to
 * `0:10` makes the row twitch for no reason.
 *
 * Its own file because two players format the same number, and two copies of a formatter is how one
 * bubble ends up saying `1:05` and the next one `01:05`.
 */
export function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
