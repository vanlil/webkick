import { tuning } from '../config.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const HELP = 'Arrows: run   Space: fire (shoot / hold to trap and pass)   1–4: tactic   X: radar   M: sound   R: new match   P: pause   G: tuning   I: info';

export function drawHud(ctx, W, H, info) {
  ctx.save();
  ctx.textBaseline = 'top';

  if (info.showDebug) {
    const lines = [
      `${info.fps.toFixed(0)} fps`,
      `ball ${(info.ballSpeed * 3.6).toFixed(0)} km/h  height ${info.ballZ.toFixed(2)} m  spin ${info.ballSpin.toFixed(2)}`,
      `player ${(info.playerSpeed * 3.6).toFixed(0)} km/h  ${info.playerState}`,
      `pitch ${tuning.game.pitchType}  wind ${tuning.game.wind}  speed ×${tuning.game.speed}  aftertouch ${tuning.game.aftertouch ? 'on' : 'off'}`,
      `CPU ${tuning.game.difficulty}  tactics ${tuning.game.humanTactic} vs ${tuning.game.cpuTactic}`,
    ];
    panel(ctx, 12, 12, lines, 13);
  }

  drawScore(ctx, W, info.teams, info.score);
  drawClock(ctx, W, info.clock, info.half);
  if (info.shootout) drawShootout(ctx, W, info.teams, info.shootout);
  if (info.prompt) drawPrompt(ctx, W, H, info.prompt);

  const { hud } = info;
  if (hud.actionTime > 0) {
    ctx.globalAlpha = Math.min(1, hud.actionTime * 2);
    ctx.font = `600 16px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(hud.action, W / 2, 80);
    ctx.globalAlpha = 1;
  }

  if (hud.bannerTime > 0) {
    const t = hud.bannerTime;
    const scale = 1 + Math.max(0, 0.25 - (hud.bannerAge || 0)) * 2; // short zoom-in
    ctx.save();
    ctx.translate(W / 2, H * 0.4);
    ctx.scale(scale, scale);
    ctx.font = `800 72px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeText(hud.banner, 0, 0);
    ctx.fillStyle = hud.bannerColor || '#ffe14d';
    ctx.fillText(hud.banner, 0, 0);
    ctx.restore();
  }

  ctx.font = `500 12px ${FONT}`;
  const w = ctx.measureText(HELP).width + 20;
  pill(ctx, (W - w) / 2, H - 34, w, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textAlign = 'center';
  ctx.fillText(HELP, W / 2, H - 28);

  if (info.paused) {
    ctx.font = `700 42px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', W / 2, H / 2);
  }
  ctx.restore();
}

function drawClock(ctx, W, seconds, half) {
  const mm = Math.floor(seconds / 60);
  const ss = Math.floor(seconds % 60);
  const text = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}   ${half === 1 ? '1st' : '2nd'} half`;
  ctx.font = `600 13px ${FONT}`;
  const w = ctx.measureText(text).width + 22;
  pill(ctx, (W - w) / 2, 48, w, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, 52);
}

// Set piece instructions, with the corner power bar (9 steps) and a hold meter.
function drawPrompt(ctx, W, H, prompt) {
  ctx.font = `600 14px ${FONT}`;
  const tw = ctx.measureText(prompt.text).width;
  const extra = prompt.power ? 9 * 14 + 16 : 0;
  const w = tw + extra + 28;
  const x = (W - w) / 2, y = H - 78;
  pill(ctx, x, y, w, 32);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.fillText(prompt.text, x + 14, y + 8);
  if (prompt.power) {
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = i < prompt.power ? '#ffe14d' : 'rgba(255,255,255,0.25)';
      ctx.fillRect(x + 14 + tw + 16 + i * 14, y + 9, 10, 14);
    }
  }
  if (prompt.pointer !== undefined) {
    // The goal seen from the penalty spot, with the direction pointer.
    const bw = Math.min(260, w - 28), bx = (W - bw) / 2, by = y - 26;
    ctx.fillStyle = 'rgba(10,20,15,0.55)';
    ctx.fillRect(bx - 6, by - 4, bw + 12, 20);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx, by + 14);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + bw, by);
    ctx.lineTo(bx + bw, by + 14);
    ctx.stroke();
    const px = bx + ((prompt.pointer + 1) / 2) * bw;
    ctx.fillStyle = '#ffe14d';
    ctx.beginPath();
    ctx.moveTo(px, by + 2);
    ctx.lineTo(px - 7, by + 15);
    ctx.lineTo(px + 7, by + 15);
    ctx.closePath();
    ctx.fill();
  }
  if (prompt.meter !== undefined) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x + 14, y + 36, w - 28, 5);
    ctx.fillStyle = '#ffe14d';
    ctx.fillRect(x + 14, y + 36, (w - 28) * Math.min(1, prompt.meter), 5);
  }
}

function drawShootout(ctx, W, teams, so) {
  const text = `Penalties   ${teams[0].name} ${so.goals[0]} : ${so.goals[1]} ${teams[1].name}`;
  ctx.font = `700 14px ${FONT}`;
  const w = ctx.measureText(text).width + 24;
  pill(ctx, (W - w) / 2, 104, w, 24);
  ctx.fillStyle = '#ffe14d';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, 109);
}

// "RED 1 : 0 BLUE" with kit colour swatches.
function drawScore(ctx, W, teams, score) {
  ctx.font = `700 18px ${FONT}`;
  const text = `${teams[0].name.toUpperCase()}  ${score[0]} : ${score[1]}  ${teams[1].name.toUpperCase()}`;
  const tw = ctx.measureText(text).width;
  const w = tw + 64;
  const x = (W - w) / 2;
  pill(ctx, x, 12, w, 32);
  const swatch = (sx, kit) => {
    ctx.fillStyle = kit.shirt;
    ctx.beginPath();
    ctx.roundRect(sx, 21, 14, 14, 3);
    ctx.fill();
    ctx.fillStyle = kit.shorts;
    ctx.fillRect(sx, 31, 14, 4);
  };
  swatch(x + 12, teams[0].kit);
  swatch(x + w - 26, teams[1].kit);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, 19);
}

function pill(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,20,15,0.55)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
}

function panel(ctx, x, y, lines, size) {
  ctx.font = `500 ${size}px ${FONT}`;
  const lh = size + 5;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
  ctx.fillStyle = 'rgba(10,20,15,0.55)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, lines.length * lh + 12, 8);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 8 + i * lh));
}
