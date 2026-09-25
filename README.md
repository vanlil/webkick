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

Milestone 3 (teams): 11 against 11, tactics (4-4-2, 4-3-3, 4-2-4, 5-3-2), automatic
switching to the player nearest to the ball, goalkeepers, and a CPU opponent with three
difficulty levels (easy / medium / hard, in the tuning panel). Throw-ins, corners and goal
kicks are taken automatically for now.

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
| L | High ball dropping in front of the player |
| R | Kick-off |
| P | Pause |
| G | Show / hide the tuning panel |
| I | Show / hide debug info |

Tuning values are saved in the browser (`localStorage`). "Copy settings (JSON)" in the panel
copies them to the clipboard.

## Third-party code

- [lil-gui](https://lil-gui.georgealways.com) 0.20.0 (MIT) — `vendor/lil-gui.esm.min.js`

## License

MIT — see `LICENSE`.
