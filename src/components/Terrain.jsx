import { useEffect, useRef } from 'react';

const COLS = 86;
const ROWS = 64;
const TAU = Math.PI * 2;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smooth = (value) => value * value * (3 - 2 * value);
const hash = (x, z) => {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return value - Math.floor(value);
};

function noise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz * (1 - fx) + (d - b) * fx * fz;
}

function landscape(u, v) {
  const x = (u - 0.5) * 2;
  const z = (v - 0.5) * 2;
  const hill = (cx, cz, spread, height) =>
    Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / spread) * height;
  const ridge =
    hill(-0.35, -0.26, 0.15, 0.44) +
    hill(0.01, -0.03, 0.095, 0.35) +
    hill(0.37, 0.02, 0.12, 0.32) +
    hill(0.58, -0.41, 0.085, 0.27) +
    hill(-0.62, 0.34, 0.075, 0.17);
  const detail =
    noise(u * 8 + 4, v * 8 + 2) * 0.055 +
    noise(u * 19, v * 19) * 0.025 +
    noise(u * 43, v * 43) * 0.013;
  const river =
    Math.exp(-((x - 0.24 * Math.sin(z * 3.3) - 0.13) ** 2) / 0.014) * (0.015 + (z + 1) * 0.02);
  return {
    x: x * 1.18 * (1 - Math.abs(z) ** 8 * 0.055),
    z: z * 0.87 * (1 - Math.abs(x) ** 8 * 0.045),
    y: 0.005 + ridge + detail - river,
    light: detail * 6 + ridge * 0.8,
  };
}

const MESH = Array.from({ length: ROWS + 1 }, (_, row) =>
  Array.from({ length: COLS + 1 }, (_, col) => landscape(col / COLS, row / ROWS)),
);

const SENSORS = [
  { u: 0.26, v: 0.54, color: '#c9f76b', phase: 0 },
  { u: 0.76, v: 0.43, color: '#eeb65e', phase: 0.38 },
  { u: 0.6, v: 0.77, color: '#f7836b', phase: 0.7 },
];

/** A dependency-free, projected land survey. Its canvas is purely decorative. */
export default function Terrain() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !context) return undefined;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let frame = 0;
    let visible = true;
    let disposed = false;
    let lastFrame = -Infinity;
    let elapsed = 0;
    let previousTime = 0;
    let pointerX = 0;
    let pointerY = 0;
    let easedX = 0;
    let easedY = 0;

    const project = (point, rotation, scale, cx, cy) => {
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      const rx = point.x * cosine + point.z * sine;
      const rz = -point.x * sine + point.z * cosine;
      return { x: cx + rx * scale, y: cy + (rz * 0.46 - point.y * 1.04) * scale };
    };

    function draw(time) {
      if (!width || !height) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      const mobile = width < 760;
      const scale = Math.min(width * (mobile ? 0.385 : 0.275), height * (mobile ? 0.42 : 0.76));
      const drift = motion.matches ? 0 : Math.sin(time * 0.00017) * 0.018;
      const rotation = -0.33 + drift + easedX * 0.035;
      const cx = width * (mobile ? 0.56 : 0.682) + easedX * 7;
      const cy = height * (mobile ? 0.7 : 0.55) + easedY * 5;
      const p = (point) => project(point, rotation, scale, cx, cy);
      const points = MESH.map((row) => row.map(p));

      // Atmospheric light under the floating parcel has no opaque canvas background.
      const atmosphere = context.createRadialGradient(
        cx,
        cy - scale * 0.12,
        scale * 0.05,
        cx,
        cy,
        scale * 1.12,
      );
      atmosphere.addColorStop(0, 'rgba(94, 153, 42, 0.105)');
      atmosphere.addColorStop(0.6, 'rgba(39, 91, 48, 0.047)');
      atmosphere.addColorStop(1, 'rgba(20, 60, 34, 0)');
      context.fillStyle = atmosphere;
      context.fillRect(cx - scale * 1.3, cy - scale, scale * 2.6, scale * 2);

      // Light dotted surveying plane visible beneath the land.
      context.fillStyle = 'rgba(149, 194, 104, 0.17)';
      for (let z = -1.2; z <= 1.4; z += 0.145) {
        for (let x = -1.5; x <= 1.5; x += 0.145) {
          const dot = p({ x, z, y: -0.33 });
          context.fillRect(dot.x, dot.y, 0.85, 0.85);
        }
      }

      // Front and right stratigraphic faces give the wireframe a real volume.
      const edge = [...MESH.map((row) => row[COLS]), ...MESH[ROWS].slice(0, -1).reverse()];
      const topEdge = edge.map(p);
      const bottomEdge = edge.map((point, index) =>
        p({
          ...point,
          y: -0.235 - noise(index * 0.29, 3) * 0.025,
        }),
      );
      context.beginPath();
      topEdge.forEach((point, index) =>
        index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
      );
      bottomEdge
        .slice()
        .reverse()
        .forEach((point) => context.lineTo(point.x, point.y));
      context.closePath();
      const cliff = context.createLinearGradient(cx, cy - scale * 0.1, cx, cy + scale * 0.7);
      cliff.addColorStop(0, 'rgba(33, 65, 39, 0.84)');
      cliff.addColorStop(0.55, 'rgba(14, 39, 28, 0.89)');
      cliff.addColorStop(1, 'rgba(12, 29, 23, 0.1)');
      context.fillStyle = cliff;
      context.fill();
      context.lineWidth = 0.55;
      topEdge.forEach((point, index) => {
        const bottom = bottomEdge[index];
        context.strokeStyle = `rgba(147, 188, 93, ${0.05 + hash(index, 7) * 0.19})`;
        context.beginPath();
        context.moveTo(point.x, point.y);
        context.lineTo(bottom.x, bottom.y);
        context.stroke();
        if (index % 2 === 0) {
          context.fillStyle = `rgba(171, 210, 111, ${0.12 + hash(index, 3) * 0.2})`;
          for (let d = 0.18; d < 0.9; d += 0.13) {
            const dx = point.x + (bottom.x - point.x) * d;
            const dy = point.y + (bottom.y - point.y) * d;
            context.fillRect(dx, dy, 0.9, 0.9);
          }
        }
      });
      context.strokeStyle = 'rgba(119, 153, 78, 0.17)';
      context.beginPath();
      bottomEdge.forEach((point, index) =>
        index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
      );
      context.stroke();

      // Coarser filled facets sit behind the much denser survey grid.
      for (let row = 0; row < ROWS; row += 2) {
        for (let col = 0; col < COLS; col += 2) {
          const rowEnd = Math.min(row + 2, ROWS);
          const colEnd = Math.min(col + 2, COLS);
          const face = [
            points[row][col],
            points[row][colEnd],
            points[rowEnd][colEnd],
            points[rowEnd][col],
          ];
          const normal = (MESH[row][col].y - MESH[rowEnd][colEnd].y) * 7;
          const light = clamp(MESH[row][col].light + normal, 0, 1);
          context.beginPath();
          face.forEach((point, index) =>
            index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
          );
          context.closePath();
          context.fillStyle = `rgb(${Math.round(19 + light * 20)}, ${Math.round(43 + light * 27)}, ${Math.round(28 + light * 6)})`;
          context.fill();
        }
      }

      context.lineWidth = mobile ? 0.48 : 0.55;
      for (let row = 0; row <= ROWS; row += 1) {
        const brightness = 0.2 + Math.sin((row / ROWS) * Math.PI) * 0.19;
        context.strokeStyle = `rgba(181, 221, 116, ${brightness})`;
        context.beginPath();
        points[row].forEach((point, index) =>
          index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y),
        );
        context.stroke();
      }
      for (let col = 0; col <= COLS; col += 1) {
        context.strokeStyle = `rgba(161, 205, 103, ${col % 5 === 0 ? 0.38 : 0.21})`;
        context.beginPath();
        points.forEach((row, index) =>
          index ? context.lineTo(row[col].x, row[col].y) : context.moveTo(row[col].x, row[col].y),
        );
        context.stroke();
      }

      // Minute reflective vertices make the peaks feel tangible, not like a flat chart.
      for (let row = 1; row < ROWS; row += 2) {
        for (let col = 1; col < COLS; col += 2) {
          if (hash(row, col) < 0.48) continue;
          const point = points[row][col];
          context.fillStyle = `rgba(214, 237, 163, ${0.12 + MESH[row][col].y * 0.52})`;
          context.fillRect(point.x - 0.45, point.y - 0.45, 0.9, 0.9);
        }
      }

      // Monitoring stations: softly pulsing rings, slender masts and a precise light.
      SENSORS.forEach((sensor) => {
        const base = landscape(sensor.u, sensor.v);
        const ground = p(base);
        const tip = p({ ...base, y: base.y + 0.14 });
        const pulse = motion.matches ? 0.4 : (time * 0.00022 + sensor.phase) % 1;
        const radius = (8 + pulse * 21) * (mobile ? 0.72 : 1);
        context.save();
        context.strokeStyle = sensor.color;
        context.globalAlpha = (1 - pulse) * 0.45;
        context.lineWidth = 0.8;
        context.beginPath();
        context.ellipse(ground.x, ground.y, radius, radius * 0.43, -0.12, 0, TAU);
        context.stroke();
        context.globalAlpha = 0.3;
        context.beginPath();
        context.ellipse(ground.x, ground.y, 6, 2.8, -0.12, 0, TAU);
        context.stroke();
        context.globalAlpha = 0.65;
        context.beginPath();
        context.moveTo(ground.x, ground.y);
        context.lineTo(tip.x, tip.y);
        context.stroke();
        const halo = context.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 13);
        halo.addColorStop(0, `${sensor.color}88`);
        halo.addColorStop(1, `${sensor.color}00`);
        context.fillStyle = halo;
        context.globalAlpha = 0.85;
        context.fillRect(tip.x - 13, tip.y - 13, 26, 26);
        context.fillStyle = sensor.color;
        context.globalAlpha = 1;
        context.beginPath();
        context.arc(tip.x, tip.y, 2.6, 0, TAU);
        context.fill();
        context.fillStyle = '#f3ffd8';
        context.beginPath();
        context.arc(tip.x - 0.4, tip.y - 0.6, 0.9, 0, TAU);
        context.fill();
        context.restore();
      });

      for (let index = 0; index < 35; index += 1) {
        const phase = hash(index, 13);
        const float = motion.matches ? 0 : Math.sin(time * 0.0003 + phase * TAU) * 0.018;
        const mote = p({
          x: (hash(index, 2) - 0.5) * 3.2,
          z: (hash(index, 5) - 0.5) * 2.8,
          y: 0.08 + phase * 0.8 + float,
        });
        context.fillStyle = `rgba(196, 225, 148, ${0.1 + phase * 0.22})`;
        context.fillRect(mote.x, mote.y, phase > 0.8 ? 1.5 : 0.8, phase > 0.8 ? 1.5 : 0.8);
      }
    }

    const animate = (now) => {
      frame = 0;
      if (disposed || !visible || document.hidden || motion.matches) return;
      if (now - lastFrame >= 32) {
        elapsed += previousTime ? Math.min(now - previousTime, 60) : 0;
        previousTime = now;
        lastFrame = now;
        easedX += (pointerX - easedX) * 0.04;
        easedY += (pointerY - easedY) * 0.04;
        draw(elapsed);
      }
      frame = window.requestAnimationFrame(animate);
    };

    function syncAnimation() {
      window.cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      if (disposed || !visible || document.hidden) return;
      if (motion.matches) {
        easedX = 0;
        easedY = 0;
        draw(0);
      } else {
        frame = window.requestAnimationFrame(animate);
      }
    }

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      draw(elapsed);
      syncAnimation();
    };

    const onPointer = (event) => {
      if (motion.matches || !visible || event.pointerType === 'touch') return;
      const bounds = canvas.getBoundingClientRect();
      pointerX = clamp(((event.clientX - bounds.left) / Math.max(width, 1)) * 2 - 1, -1, 1);
      pointerY = clamp(((event.clientY - bounds.top) / Math.max(height, 1)) * 2 - 1, -1, 1);
    };
    const resetPointer = () => {
      pointerX = 0;
      pointerY = 0;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const intersection = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        syncAnimation();
      },
      { threshold: 0 },
    );
    intersection.observe(canvas);
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('blur', resetPointer);
    document.addEventListener('visibilitychange', syncAnimation);
    motion.addEventListener('change', syncAnimation);
    resize();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('blur', resetPointer);
      document.removeEventListener('visibilitychange', syncAnimation);
      motion.removeEventListener('change', syncAnimation);
    };
  }, []);

  return (
    <div
      className="terrain-wrap"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      <canvas
        ref={canvasRef}
        className="terrain-canvas"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}
