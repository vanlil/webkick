# webkick

A fast, skill-based, top-down football game for the browser. Plain HTML + JavaScript,
no build step, no backend.

## Run

Serve the folder with any static web server (ES modules do not load from `file://`).
With the .NET SDK installed, use [dotnet-serve](https://github.com/natemcmaster/dotnet-serve):

```sh
dotnet tool install --global dotnet-serve   # once
dotnet serve -o                             # in the project folder; opens http://localhost:8080
```

Use `-p <port>` for another port.

## Status

Milestone 6 (contact): sliding tackles, fouls, 24 referees with their own strictness and
eyesight, yellow and red cards, free kicks with a wall, penalties and an optional penalty
shoot-out. Earlier: sound, full matches with halves and set pieces, 11 against 11 with tactics,
goalkeepers and a CPU opponent (easy / medium / hard, in the tuning panel).

## Controls

| Input | Action |
|---|---|
| Arrow keys | Run (8 directions). Run into the ball to push it ahead. You control the red player nearest to the ball (yellow ring). |
| Space (or Right Ctrl) just **after** touching the ball | Shoot in the running direction |
| Space held **before** reaching the ball | Trap: the ball stops at your feet |
| In trap: direction + release Space | Pass in that direction (release with no direction = dribble on) |
| In trap: forward, then back while releasing Space | Flick the ball up |
| Pull back just as you reach the ball | Lob |
| Right after any kick: arrow sideways / diagonal forward | Aftertouch: bend the ball |
| Right after any kick: arrow forward | Aftertouch: make the ball dip |
| Space with the ball in the air nearby | Jump for a header (arrow = header direction) |
| Pull back with the ball in the air in front of you | Overhead kick |
| 1 – 4 | Tactic of your team: 4-4-2, 4-3-3, 4-2-4, 5-3-2 |
| **Throw-in** | Hold Space for distance, arrow for direction; taken automatically if you wait |
| **Corner** | ←/→ power (9 steps), Space; hold Space again for height; ←/→ during the run-up for bias; then aftertouch |
| Space while an opponent has the ball at his feet | Sliding tackle. Ball first = clean; the man first, or from behind = foul |
| **Free kick** | Hold Space for height (power is random). Arrow at the kick: diagonal forward = slight bend, sideways = more bend, diagonal back = pass to a team-mate, forward = step over. Then aftertouch |
| **Penalty** | A pointer sweeps across the goal: Space fixes the direction, hold for height (quick tap = low) |
| **Penalty against you** | Arrow + Space: your keeper dives (sideways = that side, up = high, down = low); hold longer for a bigger dive |
| **Goal kick / keeper has the ball** | Arrow chooses the kick (forward = strong, centre = medium, back = weak; sideways = angle), Space kicks |
| X | Radar: small / large / off |
| M | Sound: all / crowd only / off (volumes in the tuning panel) |
| L | High ball dropping in front of the player (practice) |
| R | New match |
| P | Pause |
| G | Show / hide the tuning panel |
| I | Show / hide debug info |

Tuning values are saved in the browser (`localStorage`). "Copy settings (JSON)" in the panel
copies them to the clipboard.

## Third-party code

- [lil-gui](https://lil-gui.georgealways.com) 0.20.0 (MIT) — `vendor/lil-gui.esm.min.js`

## License

MIT — see `LICENSE`.
