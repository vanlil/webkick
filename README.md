# webkick

A fast, skill-based, top-down football game for the browser. Plain HTML + JavaScript,
no build step, no backend.

## Run

Serve the folder with any static web server (ES modules do not load from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Status

Milestone 2 (kicking): shot, trap, pass, lob, aftertouch, headers, overhead kick, flick,
goals with posts, crossbar and net.

## Controls (M2)

| Input | Action |
|---|---|
| Arrow keys | Run (8 directions). Run into the ball to push it ahead. |
| Space (or Right Ctrl) just **after** touching the ball | Shoot in the running direction |
| Space held **before** reaching the ball | Trap: the ball stops at your feet |
| In trap: direction + release Space | Pass in that direction (release with no direction = dribble on) |
| In trap: forward, then back while releasing Space | Flick the ball up |
| Pull back just as you reach the ball | Lob |
| Right after any kick: arrow sideways / diagonal forward | Aftertouch: bend the ball |
| Right after any kick: arrow forward | Aftertouch: make the ball dip |
| Space with the ball in the air nearby | Jump for a header (arrow = header direction) |
| Pull back with the ball in the air in front of you | Overhead kick |
| L | High ball dropping in front of the player |
| R | Put the ball in front of the player |
| P | Pause |
| G | Show / hide the tuning panel |
| I | Show / hide debug info |

Tuning values are saved in the browser (`localStorage`). "Copy settings (JSON)" in the panel
copies them to the clipboard.

## Third-party code

- [lil-gui](https://lil-gui.georgealways.com) 0.20.0 (MIT) — `vendor/lil-gui.esm.min.js`

## License

MIT — see `LICENSE`.
