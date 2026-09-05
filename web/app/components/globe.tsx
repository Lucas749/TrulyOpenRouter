"use client";

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import { feature, mesh } from "topojson-client";

// Region slug → lon/lat. Hosts with unknown regions stay in the table (honest globe:
// every dot is a registered host, no invented nodes).
const COORDS: Record<string, [number, number]> = {
  "us-west": [-122.4, 37.8], "us-east": [-77.5, 39.0], "us-central": [-98.5, 29.4],
  "ca-central": [-79.4, 43.7], "sa-east": [-46.6, -23.5],
  "eu-central": [8.7, 50.1], "eu-west": [4.9, 52.4], "eu-north": [18.1, 59.3], "eu-south": [14.5, 41.9],
  "af-west": [3.4, 6.5], "af-south": [18.4, -33.9],
  "ap-south": [72.9, 19.1], "ap-se": [103.8, 1.35], "ap-ne": [139.7, 35.7], "ap-east": [114.1, 22.3], "ap-oce": [151.2, -33.9],
};

export interface GlobeHost {
  id: string;
  region: string | null;
  active: boolean;
}

const COLOR = { ok: "#10A37F", down: "#DC2626" };
const GATEWAY: [number, number] = [-0.13, 51.5];

export default function Globe({ hosts }: { hosts: GlobeHost[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nodes = hosts
      .filter((h) => h.region && COORDS[h.region])
      .map((h) => ({ ...h, lon: COORDS[h.region as string][0], lat: COORDS[h.region as string][1] }));
    const projection = d3.geoOrthographic().clipAngle(90);
    const path = d3.geoPath(projection, ctx as any);
    const graticule = d3.geoGraticule10();
    let land: any = null;
    let W = 0, H = 0, rotation = -8;
    const arcs: { host: (typeof nodes)[number]; interp: (t: number) => [number, number]; t: number; speed: number; tier: number; settledAt: number | null }[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      projection.scale(Math.min(W, H) * 0.46).translate([W / 2, H * 0.5]);
    };
    const visible = (lon: number, lat: number) => {
      const c = projection.rotate();
      return d3.geoDistance([lon, lat], [-c[0], -c[1]]) < Math.PI / 2 - 0.03;
    };
    const spawn = () => {
      const pool = nodes.filter((h) => h.active);
      if (!pool.length || arcs.length >= 40) return;
      const host = pool[Math.floor(Math.random() * pool.length)];
      arcs.push({ host, interp: d3.geoInterpolate(GATEWAY, [host.lon, host.lat]), t: 0, speed: 0.0055 + Math.random() * 0.0045, tier: 1 + Math.floor(Math.random() * 3), settledAt: null });
    };
    const draw = (elapsed: number) => {
      if (!REDUCED) rotation = -8 + elapsed * 0.0038;
      ctx.clearRect(0, 0, W, H);
      projection.rotate([rotation, -14, 0]);
      ctx.beginPath(); path({ type: "Sphere" } as any);
      ctx.fillStyle = "#0C1119"; ctx.fill();
      ctx.strokeStyle = "#1E2632"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); path(graticule as any);
      ctx.strokeStyle = "rgba(30,38,50,0.9)"; ctx.lineWidth = 0.5; ctx.stroke();
      if (land) {
        ctx.beginPath(); path(land);
        ctx.fillStyle = "#161C27"; ctx.fill();
        ctx.strokeStyle = "#232C3A"; ctx.lineWidth = 0.4; ctx.stroke();
      }
      for (let i = arcs.length - 1; i >= 0; i--) {
        const a = arcs[i];
        if (!REDUCED) {
          a.t += a.speed;
          if (a.t >= 1 && !a.settledAt) a.settledAt = Date.now();
          if (a.settledAt && Date.now() - a.settledAt > 720) { arcs.splice(i, 1); continue; }
        }
        const head = Math.min(a.t, 1), tail = Math.max(0, head - 0.55);
        ctx.beginPath();
        let started = false;
        for (let s = 0; s <= 44; s++) {
          const pt = projection(a.interp(tail + (head - tail) * (s / 44)));
          if (!pt) { started = false; continue; }
          if (!started) { ctx.moveTo(pt[0], pt[1]); started = true; }
          else ctx.lineTo(pt[0], pt[1]);
        }
        const grad = ctx.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, "rgba(37,99,235,0.85)");
        grad.addColorStop(1, "rgba(16,163,127,0.95)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 0.6 + a.tier * 0.4;
        ctx.globalAlpha = a.settledAt ? Math.max(0, 1 - (Date.now() - a.settledAt) / 700) : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (visible(GATEWAY[0], GATEWAY[1])) {
        const g = projection(GATEWAY)!;
        ctx.beginPath(); ctx.arc(g[0], g[1], 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = "#E6EAF0"; ctx.lineWidth = 1.1; ctx.stroke();
      }
      const now = Date.now();
      nodes.forEach((hst) => {
        if (!visible(hst.lon, hst.lat)) return;
        const p = projection([hst.lon, hst.lat])!;
        const c = hst.active ? COLOR.ok : COLOR.down;
        const blink = !hst.active && !REDUCED ? 0.45 + 0.35 * Math.sin(now / 420) : 1;
        ctx.globalAlpha = blink;
        ctx.beginPath(); ctx.arc(p[0], p[1], 2.4, 0, Math.PI * 2);
        ctx.fillStyle = c; ctx.fill();
        ctx.globalAlpha = 1;
      });
    };

    resize();
    window.addEventListener("resize", resize);
    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json")
      .then((topo: any) => {
        land = feature(topo, topo.objects.countries);
        draw(0);
      })
      .catch(() => draw(0));
    let timer: any = null;
    if (!REDUCED) {
      timer = d3.timer(draw);
      spawn();
      const spawner = setInterval(spawn, 900);
      (timer as any).spawner = spawner;
      const origStop = timer.stop.bind(timer);
      timer.stop = () => { clearInterval(spawner); origStop(); };
    } else {
      draw(0);
    }
    return () => {
      window.removeEventListener("resize", resize);
      if (timer) timer.stop();
    };
  }, [hosts]);

  return <canvas ref={ref} className="h-full w-full" aria-label="Host network globe" />;
}
